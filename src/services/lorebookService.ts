import { LorebookEntry } from '../types';
import { RAGService } from './ragService';

/** 트리거 방식. 명시적인 것(정규식/키워드)을 임베딩 유사도보다 우선한다. */
type TriggerKind = 'regex' | 'keyword' | 'semantic';

const KIND_PRIORITY: Record<TriggerKind, number> = { regex: 3, keyword: 2, semantic: 1 };
const DEPTH_PRIORITY: Record<'high' | 'mid' | 'low', number> = { high: 3, mid: 2, low: 1 };

/** 한글·영숫자를 단어 구성 문자로 본다. */
const WORD_CHAR = /[0-9A-Za-z가-힣]/;
/** 공백을 포함한 순수 ASCII 키인지. 이 경우에만 뒤쪽 경계까지 본다. */
const ASCII_KEY = /^[0-9A-Za-z ]+$/;
/**
 * ASCII 키 뒤에 허용되는 꼬리.
 * 흔한 굴절 어미(cats, boxes, walked, running)까지는 같은 낱말로 보고,
 * 그 밖에 단어 문자가 이어지면(catalog) 다른 낱말로 본다.
 */
const ASCII_TAIL = /^(?:'s|ing|es|ed|s)?(?![0-9A-Za-z가-힣])/;

export interface LorebookScanOptions {
    /** 임베딩 유사도 임계값. 0 이하면 시맨틱 트리거를 끈다. */
    semanticThreshold?: number;
    /** 한 턴에 주입할 최대 엔트리 수. */
    maxEntries?: number;
    maxRecursionDepth?: number;
}

interface Candidate {
    entry: LorebookEntry;
    kind: TriggerKind;
    score: number;
}

export class LorebookService {
    /**
     * 키워드가 문맥에 등장하는지 검사한다.
     *
     * 단순 substring 매칭은 한국어에서 "린"이 "그린"에 걸리는 식으로 과다 매칭된다.
     * 그래서 키 앞 글자가 단어 문자면 다른 낱말의 일부로 보고 넘긴다.
     * 뒤쪽은 검사하지 않는다 — 한국어는 조사가 붙기 때문이다("왕국을", "왕국에서").
     * 순수 ASCII 키는 조사가 없으므로 뒤쪽 경계까지 확인한다("cat"이 "catalog"에 걸리지 않도록).
     */
    public static matchesKey(haystack: string, key: string): boolean {
        const needle = key.trim().toLowerCase();
        if (!needle) return false;

        const text = haystack.toLowerCase();
        const checkTail = ASCII_KEY.test(needle);

        let from = 0;
        while (from <= text.length - needle.length) {
            const idx = text.indexOf(needle, from);
            if (idx === -1) return false;

            const before = idx > 0 ? text[idx - 1] : '';
            const headOk = !before || !WORD_CHAR.test(before);
            const tailOk = !checkTail || ASCII_TAIL.test(text.slice(idx + needle.length));

            if (headOk && tailOk) return true;
            from = idx + 1;
        }
        return false;
    }

    /**
     * 최근 문맥을 훑어 해당하는 로어북 엔트리를 찾는다.
     * 재귀 스캔을 지원하며, 마지막에 depth·트리거 방식 우선순위로 잘라낸다.
     */
    public static scan(
        entries: LorebookEntry[],
        recentContext: string,
        recentContextEmbedding?: number[],
        options: LorebookScanOptions = {}
    ): { high: string[], mid: string[], low: string[] } {
        const empty = { high: [] as string[], mid: [] as string[], low: [] as string[] };
        if (!entries || entries.length === 0) return empty;

        const {
            semanticThreshold = 0,
            maxEntries = 10,
            maxRecursionDepth = 2,
        } = options;

        const semanticEnabled = semanticThreshold > 0
            && Array.isArray(recentContextEmbedding)
            && recentContextEmbedding.length > 0;

        const seen = new Set<string>();
        const candidates: Candidate[] = [];

        let textToScan = recentContext;
        let depth = 0;

        while (depth <= maxRecursionDepth && textToScan.length > 0) {
            let recursionText = '';
            let triggeredThisPass = false;

            for (const entry of entries) {
                if (seen.has(entry.id)) continue;
                if (Math.random() * 100 > entry.probability) continue;

                let kind: TriggerKind | null = null;
                let score = 0;

                if (entry.regex) {
                    try {
                        if (new RegExp(entry.regex, 'i').test(textToScan)) kind = 'regex';
                    } catch (e) {
                        console.error(`Invalid regex in lorebook entry ${entry.id}:`, e);
                    }
                }

                if (!kind && entry.keys?.length) {
                    if (entry.keys.some(key => this.matchesKey(textToScan, key))) kind = 'keyword';
                }

                if (!kind && semanticEnabled && entry.embedding?.length) {
                    const similarity = RAGService.cosineSimilarity(recentContextEmbedding!, entry.embedding);
                    if (similarity >= semanticThreshold) {
                        kind = 'semantic';
                        score = similarity;
                    }
                }

                if (!kind) continue;

                seen.add(entry.id);
                candidates.push({ entry, kind, score });
                triggeredThisPass = true;

                if (entry.recursable) recursionText += ' ' + entry.content;
            }

            if (!triggeredThisPass || recursionText.trim() === '') break;
            textToScan = recursionText;
            depth++;
        }

        // depth(중요도) → 트리거 방식 → 유사도 순으로 정렬한 뒤 상한만큼만 남긴다.
        // 로어북이 커져도 매 턴 주입되는 양이 무한정 늘지 않게 하는 안전장치다.
        const selected = candidates
            .sort((a, b) => {
                const byDepth = DEPTH_PRIORITY[b.entry.depth] - DEPTH_PRIORITY[a.entry.depth];
                if (byDepth !== 0) return byDepth;
                const byKind = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
                if (byKind !== 0) return byKind;
                return b.score - a.score;
            })
            .slice(0, Math.max(0, maxEntries));

        const results = { high: [] as string[], mid: [] as string[], low: [] as string[] };
        for (const { entry } of selected) {
            const bucket = ['high', 'mid', 'low'].includes(entry.depth) ? entry.depth : 'mid';
            results[bucket as 'high' | 'mid' | 'low'].push(entry.content);
        }
        return results;
    }
}
