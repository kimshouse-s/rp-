import { ChatRoom, LorebookEntry, Message, MessageVariant, MemorySlots } from '../types';
import {
    DEFAULT_CUSTOM_PROMPT,
    DEFAULT_ROLE_DEFINITION,
    DEFAULT_OUTPUT_CONTRACT,
    DEFAULT_THINKING_MODE_INSTRUCTIONS,
} from '../constants';
import { DEFAULT_CLAUDE_MODEL } from './claudeClient';

/**
 * 캐릭터 카드(Character Card V2/V3) 임포트.
 *
 * 카드는 PNG 파일의 tEXt 청크에 base64로 인코딩된 JSON이 박혀 있는 형식이다.
 * V2는 키워드 'chara', V3는 'ccv3'를 쓴다. chub.ai 등에서 공유되는 카드가 이 규격이다.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface CardBookEntry {
    keys?: string[];
    content?: string;
    enabled?: boolean;
    constant?: boolean;
    position?: string;
    case_sensitive?: boolean;
}

interface CardData {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    character_book?: { entries?: CardBookEntry[] };
    creator?: string;
    character_version?: string;
}

export interface ParsedCard {
    spec: 'v1' | 'v2' | 'v3';
    data: CardData;
    /** 지원하지 않아 버린 항목. 사용자에게 그대로 알린다. */
    warnings: string[];
}

const decodeBase64Utf8 = (base64: string): string => {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
};

/**
 * PNG 청크를 훑어 tEXt 항목을 전부 뽑는다.
 * 청크 구조는 [길이 4바이트][타입 4바이트][데이터][CRC 4바이트]이고,
 * tEXt 데이터는 `키워드\0값` 형태다.
 */
const readPngTextChunks = (buffer: ArrayBuffer): Map<string, string> => {
    const bytes = new Uint8Array(buffer);
    const result = new Map<string, string>();

    if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
        throw new Error('PNG 파일이 아닙니다.');
    }

    const view = new DataView(buffer);
    const latin1 = new TextDecoder('latin1');
    let offset = 8;

    while (offset + 8 <= bytes.length) {
        const length = view.getUint32(offset);
        const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > bytes.length) break;

        if (type === 'tEXt') {
            const data = bytes.subarray(dataStart, dataEnd);
            const nul = data.indexOf(0);
            if (nul > 0) {
                const keyword = latin1.decode(data.subarray(0, nul));
                // 값은 base64 ASCII라 latin1으로 읽어도 안전하다. UTF-8 복원은 디코딩 단계에서 한다.
                result.set(keyword, latin1.decode(data.subarray(nul + 1)));
            }
        }

        if (type === 'IEND') break;
        offset = dataEnd + 4; // CRC 건너뛰기
    }

    return result;
};

export function parseCharacterCardPng(buffer: ArrayBuffer): ParsedCard {
    const chunks = readPngTextChunks(buffer);
    const warnings: string[] = [];

    // V3(ccv3)를 우선한다. 둘 다 있으면 V3가 더 많은 정보를 담는다.
    const raw = chunks.get('ccv3') ?? chunks.get('chara');
    if (!raw) {
        const found = [...chunks.keys()];
        throw new Error(
            found.length
                ? `캐릭터 카드 정보가 없습니다. (PNG에 있는 항목: ${found.join(', ')})`
                : '캐릭터 카드 정보가 없습니다. 카드가 아닌 일반 이미지일 수 있습니다.'
        );
    }

    let parsed: any;
    try {
        parsed = JSON.parse(decodeBase64Utf8(raw));
    } catch (e: any) {
        throw new Error(`카드 데이터를 읽을 수 없습니다: ${e?.message || e}`);
    }

    // V2/V3는 { spec, data: {...} }, V1은 필드가 최상위에 그대로 있다.
    const isWrapped = parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object';
    const data: CardData = isWrapped ? parsed.data : parsed;
    const spec: ParsedCard['spec'] = chunks.has('ccv3') ? 'v3' : (isWrapped ? 'v2' : 'v1');

    if (!data || typeof data !== 'object' || (!data.name && !data.description)) {
        throw new Error('카드에 캐릭터 정보가 비어 있습니다.');
    }

    return { spec, data, warnings };
}

/** 카드의 character_book을 이 앱의 로어북 항목으로 옮긴다. */
const convertCharacterBook = (entries: CardBookEntry[] | undefined, warnings: string[]): LorebookEntry[] => {
    if (!entries?.length) return [];

    const converted: LorebookEntry[] = [];
    let skipped = 0;

    entries.forEach((entry, i) => {
        if (entry.enabled === false) { skipped++; return; }
        const content = (entry.content ?? '').trim();
        if (!content) { skipped++; return; }

        const keys = (entry.keys ?? []).map(k => String(k).trim()).filter(Boolean);

        // constant 항목은 키워드와 무관하게 항상 들어가야 한다.
        // 이 앱에는 '항상' 플래그가 없으므로 무엇이든 매칭되는 정규식으로 대신한다.
        const isConstant = entry.constant === true;
        if (!isConstant && keys.length === 0) { skipped++; return; }

        converted.push({
            id: `lore_card_${Date.now()}_${i}`,
            keys,
            regex: isConstant ? '.' : undefined,
            content,
            probability: 100,
            // 카드의 position은 캐릭터 설명 앞/뒤를 뜻한다. 앞이면 세계관 규칙에 가깝다.
            depth: entry.position === 'before_char' ? 'high' : 'mid',
            recursable: false,
            // sourceMessageId를 비워 두면 수동 생성으로 취급돼 롤백 대상에서 제외된다.
        });

        if (entry.case_sensitive) {
            warnings.push('일부 로어북 항목의 대소문자 구분 설정은 적용되지 않았습니다.');
        }
    });

    if (skipped > 0) {
        warnings.push(`로어북 항목 ${skipped}개는 비어 있거나 꺼져 있어 건너뛰었습니다.`);
    }
    return converted;
};

const joinSections = (sections: (string | undefined)[]): string =>
    sections.map(s => (s ?? '').trim()).filter(Boolean).join('\n\n');

/**
 * 카드를 새 채팅방으로 변환한다.
 *
 * roleDefinition과 outputContract는 카드 값으로 덮어쓰지 않는다. 이 앱의 기본 프롬프트가
 * 별도로 다듬어져 있어서, 카드에 흔히 들어있는 범용 지침으로 갈아치우면 품질이 떨어진다.
 * 카드의 system_prompt·post_history_instructions는 시나리오에 표시해 두고 사용자가 판단하게 한다.
 */
export function cardToChatRoom(card: ParsedCard): { room: ChatRoom; warnings: string[] } {
    const { data } = card;
    const warnings = [...card.warnings];

    const persona = joinSections([
        data.name ? `[Name: ${data.name}]` : undefined,
        data.description,
        data.personality ? `[Personality]\n${data.personality}` : undefined,
        data.mes_example ? `[Dialogue Examples]\n${data.mes_example}` : undefined,
    ]);

    const cardInstructions = joinSections([
        data.system_prompt ? `[카드 제공 지침]\n${data.system_prompt}` : undefined,
        data.post_history_instructions ? `[카드 제공 후처리 지침]\n${data.post_history_instructions}` : undefined,
    ]);

    if (cardInstructions) {
        warnings.push('카드의 시스템 지침은 시나리오 슬롯에 참고용으로 넣었습니다. 앱의 역할/출력 규칙은 그대로 유지됩니다.');
    }

    const memory: MemorySlots = {
        persona,
        scenario: joinSections([data.scenario, cardInstructions]),
        user_persona: '',
        state: '',
        short_term_memory: '',
        planning: '',
    };

    const roomId = `chat_${Date.now()}`;
    const messages: Message[] = [];
    const snapshots: ChatRoom['snapshots'] = [];

    // 첫 인사말. alternate_greetings가 있으면 스와이프 후보로 넣는다.
    const greetings = [data.first_mes, ...(data.alternate_greetings ?? [])]
        .map(g => (g ?? '').trim())
        .filter(Boolean);

    if (greetings.length > 0) {
        const timestamp = new Date().toISOString();
        const variants: MessageVariant[] = greetings.map(text => ({
            text,
            memory,
            timestamp,
        }));

        const greetingMessage: Message = {
            id: `msg_${Date.now()}`,
            text: greetings[0],
            sender: 'ai',
            timestamp,
            variants: variants.length > 1 ? variants : undefined,
            activeVariant: variants.length > 1 ? 0 : undefined,
        };
        messages.push(greetingMessage);
        snapshots.push({ messageId: greetingMessage.id, memory });

        if (greetings.length > 1) {
            warnings.push(`대체 인사말 ${greetings.length - 1}개를 스와이프 후보로 넣었습니다.`);
        }
    }

    const room: ChatRoom = {
        id: roomId,
        title: data.name?.trim() || '이름 없는 캐릭터',
        messages,
        customPrompt: DEFAULT_CUSTOM_PROMPT,
        roleDefinition: DEFAULT_ROLE_DEFINITION,
        outputContract: DEFAULT_OUTPUT_CONTRACT,
        memory,
        lorebook: convertCharacterBook(data.character_book?.entries, warnings),
        vectorMemory: [],
        snapshots,
        temperature: 0.8,
        topP: 0.95,
        presencePenalty: 0,
        frequencyPenalty: 0,
        thinkingMode: 'simple',
        thinkingModeInstructions: DEFAULT_THINKING_MODE_INSTRUCTIONS,
        mode: 'roleplay',
        provider: 'gemini',
        modelName: 'gemini-3.1-pro-preview',
        claudeModel: DEFAULT_CLAUDE_MODEL,
        ragThreshold: 0.0,
        maxContextTurns: 3,
        lorebookThreshold: 0,
        lorebookMaxEntries: 10,
    };

    return { room, warnings };
}
