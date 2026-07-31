import { StatDefinition } from '../types';

/**
 * 스탯 엔진.
 *
 * 모델은 "이번 턴에 호감도 +5" 같은 증감만 제안하고, 상한·감쇠·발현 규칙은 여기서 강제한다.
 * 규칙을 프롬프트에만 맡기면 증가 조건이 감소 조건보다 넓을 때 값이 한쪽으로만 흘러
 * 결국 최대치에 붙어버린다(이 앱의 이전 집착도 규칙이 정확히 그랬다).
 */

export interface StatDelta {
    id: string;
    delta: number;
}

export interface StatTrigger {
    id: string;
    label: string;
    /** 임계를 넘은 순간의 값. 리셋 전 값이다. */
    peakValue: number;
    effect?: string;
}

export interface StatTurnResult {
    stats: StatDefinition[];
    triggers: StatTrigger[];
    /** 사람이 읽을 변경 내역. 메모리 변경 패널에 그대로 쓴다. */
    log: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * 응답 텍스트에서 스탯 증감을 뽑는다.
 *
 * <stat-update>
 *   affection: +5
 *   patience: +20
 * </stat-update>
 *
 * 구분자는 `:` `=` 또는 공백 무엇이든 받는다. 모델이 형식을 조금씩 틀려도 통과시키기 위해서다.
 */
export function parseStatDeltas(text: string): { deltas: StatDelta[]; cleanedText: string } {
    const blockRegex = /<stat[\s_-]*update[^>]*>([\s\S]*?)<\/stat[\s_-]*update>/gi;
    const deltas: StatDelta[] = [];

    let match;
    while ((match = blockRegex.exec(text)) !== null) {
        for (const line of match[1].split('\n')) {
            const m = line.match(/([A-Za-z_][A-Za-z0-9_]*)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/);
            if (m) deltas.push({ id: m[1], delta: parseFloat(m[2]) });
        }
    }

    return { deltas, cleanedText: text.replace(blockRegex, '').trim() };
}

/**
 * 한 턴 분량을 적용한다. 순서는 감쇠 → 증감 → 발현 판정이다.
 *
 * 감쇠를 먼저 두는 이유: '시간이 흐른 뒤 이번 턴의 사건이 일어난다'는 순서가 자연스럽고,
 * 모델이 명시한 증감이 같은 턴에 곧바로 깎이지 않는다.
 */
export function applyStatTurn(
    stats: StatDefinition[] | undefined,
    deltas: StatDelta[]
): StatTurnResult {
    if (!stats?.length) return { stats: [], triggers: [], log: [] };

    const deltaById = new Map<string, number>();
    for (const d of deltas) {
        deltaById.set(d.id, (deltaById.get(d.id) ?? 0) + d.delta);
    }

    const triggers: StatTrigger[] = [];
    const log: string[] = [];

    const next = stats.map(stat => {
        const before = stat.value;
        let value = before;

        // 1. 감쇠 (지속형만). 기준선을 지나치지 않도록 목표까지의 거리로 제한한다.
        if (stat.kind === 'persistent' && stat.decayPerTurn) {
            const baseline = stat.baseline ?? stat.min;
            const gap = baseline - value;
            if (gap !== 0) {
                const step = Math.min(Math.abs(stat.decayPerTurn), Math.abs(gap));
                value += Math.sign(gap) * step;
            }
        }

        // 2. 모델이 제안한 증감
        const delta = deltaById.get(stat.id);
        if (delta) value += delta;

        value = round2(clamp(value, stat.min, stat.max));

        // 3. 발현 판정 (게이지형만)
        let triggered = false;
        if (stat.kind === 'gauge' && stat.threshold !== undefined && value >= stat.threshold) {
            triggers.push({ id: stat.id, label: stat.label, peakValue: value, effect: stat.triggerEffect });
            value = round2(clamp(stat.resetTo ?? stat.min, stat.min, stat.max));
            triggered = true;
        }

        if (value !== before) {
            const arrow = `${before} → ${value}`;
            log.push(triggered ? `[${stat.label}] 발현! (${before} → 리셋 ${value})` : `[${stat.label}] ${arrow}`);
        }

        return { ...stat, value };
    });

    return { stats: next, triggers, log };
}

/** 현재 스탯을 프롬프트에 넣을 블록으로 만든다. 정의가 없으면 빈 문자열이라 아무것도 주입되지 않는다. */
export function buildStatPrompt(stats: StatDefinition[] | undefined): string {
    if (!stats?.length) return '';

    const lines = stats.map(stat => {
        const parts = [`- ${stat.label} (${stat.id}): ${stat.value} / ${stat.min}~${stat.max}`];

        if (stat.kind === 'gauge' && stat.threshold !== undefined) {
            const remaining = round2(Math.max(0, stat.threshold - stat.value));
            parts.push(`  · 게이지: ${stat.threshold} 이상이면 발현. 남은 양 ${remaining}.`);
            if (stat.triggerEffect) parts.push(`  · 발현 시: ${stat.triggerEffect}`);
        } else if (stat.kind === 'persistent' && stat.decayPerTurn) {
            parts.push(`  · 아무 일이 없으면 매 턴 ${stat.baseline ?? stat.min} 쪽으로 ${stat.decayPerTurn}씩 돌아간다.`);
        }

        if (stat.description) parts.push(`  · ${stat.description}`);
        return parts.join('\n');
    });

    return `
    <stats>
        현재 수치다. 값은 시스템이 관리하며, 네가 직접 최종값을 쓰지 않는다.
${lines.join('\n')}

        이번 턴에 변화가 있으면 응답 끝에 증감만 적어라. 없으면 블록 자체를 생략한다.
        <stat-update>
        스탯id: +정수 또는 -정수
        </stat-update>

        - 증감만 적는다. 최종값을 적으면 무시된다.
        - 상한·하한, 감쇠, 발현과 리셋은 시스템이 알아서 처리한다. 계산하지 마라.
        - 근거 없이 매 턴 올리지 마라. 장면에서 실제로 그럴 일이 있었을 때만 움직인다.
    </stats>`;
}

/**
 * 정의는 그대로 두고 값만 초기 상태로 되돌린다.
 * 대화를 전부 지웠을 때 쓴다. 스탯 정의는 방 설정이므로 같이 날려선 안 된다.
 */
export function resetStatValues(stats: StatDefinition[] | undefined): StatDefinition[] | undefined {
    if (!stats?.length) return stats;
    return stats.map(stat => ({
        ...stat,
        value: round2(clamp(stat.kind === 'gauge' ? (stat.resetTo ?? stat.min) : (stat.baseline ?? stat.min), stat.min, stat.max)),
    }));
}

/** 게이지 발현을 다음 턴 프롬프트가 볼 수 있도록 단기 기억에 남길 문장으로 만든다. */
export function formatTriggerNote(trigger: StatTrigger): string {
    const effect = trigger.effect ? ` ${trigger.effect}` : '';
    return `[${trigger.label} 발현] 임계 돌파(${trigger.peakValue}). 이번 장면에서 그 결과가 드러나야 한다.${effect}`;
}
