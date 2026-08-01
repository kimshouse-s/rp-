# CLAUDE.md

Gemini 기반 롤플레이 메신저 앱. AI Studio에서 만들어진 프로젝트를 Claude Code로 이월했다.

## 명령어

```bash
npm run dev      # Vite 개발 서버 (http://localhost:3000)
npm run build    # dist/ 로 프로덕션 빌드
npm run preview  # 빌드 결과 미리보기
npm run lint     # tsc --noEmit 타입 체크
```

테스트 러너는 없다. 변경 후 최소한 `npm run lint`와 `npm run build`를 돌린다.

## 생성 엔진 (프로바이더)

방마다 `provider`로 고른다 (설정 → 모델 설정 → 생성 엔진).

- **`gemini`** (기본) — 브라우저에서 Gemini API 직접 호출. `GEMINI_API_KEY` 필요.
- **`claude`** — 개발 서버의 `POST /api/chat`을 거쳐 Claude 구독 인증으로 생성. API 키 불필요.

`claude`는 [server/claudeBridge.ts](server/claudeBridge.ts)가 처리한다. Vite 플러그인이라
**`npm run dev`에서만 살아있다** (`npm run preview`나 정적 배포에는 없다).
`@anthropic-ai/claude-agent-sdk`가 Claude Code와 같은 방식으로 자격증명을 찾는다.

**사전 조건: 터미널에서 `claude` 실행 후 `/login` 을 한 번 해야 한다.** CLI 로그인이
디스크에 저장되어야 SDK가 인증을 잡는다. 안 되어 있으면 브릿지가
`Not logged in · Please run /login` 을 에러로 돌려준다.
(SDK는 미로그인 시 `subtype: 'success'` + `is_error: true`로 응답하므로 `is_error`를 반드시 봐야 한다.)

Claude 경로에는 툴을 선언하지 않는다. 프롬프트가 이미 `<mem-update>` / `<lorebook-update>` /
`<rag-update>` 태그 규약을 설명하고, `ChatRoomView`의 정규식 폴백이 그 태그를 파싱한다.
Claude에는 temperature·topP·페널티가 적용되지 않는다 (Anthropic이 최신 모델에서 제거).

**임베딩은 프로바이더와 무관하게 항상 Gemini를 쓴다.** Anthropic에는 임베딩 API가 없다.
Gemini 키가 없으면 `RAGService.generateEmbedding`이 빈 배열을 반환해 임베딩 기반 기능
(RAG 유사도 검색, 로어북 시맨틱 트리거)만 조용히 꺼진다. 생성 자체는 정상 동작한다.

## API 키

`GEMINI_API_KEY`를 프로젝트 루트의 `.env.local`에 넣는다 (`.env.example` 참고).
[vite.config.ts](vite.config.ts)가 이 값을 `process.env.GEMINI_API_KEY` / `process.env.API_KEY`로
번들에 주입하고, [src/App.tsx](src/App.tsx)에서 `GoogleGenAI` 클라이언트를 만든다.
키가 없으면 앱은 뜨지만 `ai`가 `null`이라 생성 요청이 동작하지 않는다.

주의: 브라우저 번들에 키가 그대로 박히므로 이 앱은 로컬 실행 전용이다. 공개 배포하면 키가 노출된다.

## 스탯 (호감도·인내심 등)

[src/services/statEngine.ts](src/services/statEngine.ts). `MemorySlots.stats`에 방마다 정의한다.
정의가 없으면 프롬프트에서 통째로 빠진다.

**모델은 증감만 제안하고, 규칙은 코드가 강제한다.** 상한·감쇠·발현을 프롬프트에만 맡기면
증가 조건이 감소 조건보다 넓을 때 값이 한쪽으로만 흘러 최대치에 붙는다 (이 앱의 옛
`buildRelationshipContext`가 정확히 그랬고, 그래서 제거했다).

- `persistent` — 호감도·질투·집착도. 아무 일 없으면 매 턴 `baseline` 쪽으로 `decayPerTurn`만큼
  되돌아간다. 기준선을 지나치지 않게 남은 거리로 제한한다.
- `gauge` — 인내심. `threshold` 이상이면 발현하고 `resetTo`로 되돌아간다.

**게이지는 '참고 있는 정도'다.** 분노 수치가 아니다. 하고 싶은 말·질투·욕망을 삼키고 있는
상태 전부를 뜻한다. 임계 전까지는 다른 수치가 아무리 높아도 캐릭터가 겉으로 드러내지 않고,
그 격차가 긴장을 만든다. `buildStatPrompt`가 게이지가 하나라도 있을 때만 이 설명을 붙인다
(없으면 토큰을 쓰지 않는다). 이 설명을 빼면 모델이 게이지를 단순 분노로 읽고 쌓이는 동안에도
감정을 그대로 드러내, 스탯이 아무 의미가 없어진다.

**설계 모드에서는 스탯이 완전히 빠진다.** 프롬프트에도 안 들어가고(`buildVolatileState`의
`includeStats`), 증감 계산도 돌지 않는다(`ChatRoomView`의 mode 검사). 세계관을 짜는 대화로
수치가 오르내리면 연기를 시작하기도 전에 값이 오염된다.

턴 적용 순서는 **감쇠 → 증감 → 발현 판정**이다. 감쇠를 먼저 둬야 모델이 명시한 증감이
같은 턴에 곧바로 깎이지 않는다.

게이지 발현은 별도 상태 필드를 두지 않고 `short_term_memory`에 한 줄로 남긴다.
그래야 스냅샷·롤백·스와이프에 자동으로 따라간다.

`update_memory`는 `stats`에 쓸 수 없다 (`isMemoryTextSlot`이 막는다). 배열 슬롯이
자유 텍스트로 덮이면 정의가 통째로 날아가기 때문이다. 증감은 `<stat-update>`로만 받는다.

## 캐릭터 카드 임포트

[src/services/characterCard.ts](src/services/characterCard.ts). PNG의 `tEXt` 청크에서
base64 JSON을 꺼낸다. 키워드는 V3가 `ccv3`, V2가 `chara`이고 V3를 우선한다.
V1(필드가 최상위에 평면으로 있는 구형)도 받는다. 압축된 `zTXt` 청크는 지원하지 않는다.

매핑에서 의도적으로 정한 것들:

- **`roleDefinition`·`outputContract`는 카드 값으로 덮어쓰지 않는다.** 이 앱의 기본
  프롬프트가 따로 다듬어져 있어서, 카드에 흔한 범용 지침으로 갈아치우면 품질이 떨어진다.
  카드의 `system_prompt`·`post_history_instructions`는 `memory.scenario`에 라벨을 붙여 넣고
  경고로 알린다.
- `alternate_greetings`는 첫 메시지의 **스와이프 후보**가 된다.
- `character_book`의 `constant: true` 항목은 이 앱에 '항상 주입' 플래그가 없으므로
  무엇이든 매칭되는 정규식 `.` 으로 대신한다.
- 카드 로어북은 `sourceMessageId`를 비워 둔다 → 수동 생성으로 취급돼 분기 롤백에서 보존된다.

## 모바일 접속

같은 네트워크의 폰에서 `http://<PC의 LAN IP>:3000` 으로 붙는다. `npm run dev` 시작 시
Vite가 Network 주소를 출력한다. `host: true` + `strictPort: true`라 포트가 조용히
바뀌지 않는다. Windows 방화벽에서 Node.js 인바운드 허용이 필요하다.

`html, body, #root`는 `height: 100%` 뒤에 `100dvh`를 겹쳐 쓴다. 모바일은 주소창·키보드가
뜨면 `100%`가 실제 보이는 높이보다 커져서 입력창이 화면 밖으로 밀린다. 이 줄을 지우지 말 것.

좁은 화면(≤768px)에서는 출력 필터가 접혀 있고 `filter-disclosure` 버튼으로 편다
(`ChatRoomView`의 `isFilterOpen`). 헤더가 화면의 1/4을 먹는 걸 막기 위한 것이다.

## 구조

- `index.html` — 전체 CSS가 인라인으로 들어있는 단일 진입 HTML. 스타일 수정은 여기서 한다.
  다크 모드는 `body.dark-mode` 클래스 + CSS 변수로 처리.
- `src/App.tsx` — 최상위. 채팅방 목록/선택, 테마, localStorage 영속화, Gemini 클라이언트 초기화.
  `chatRooms`가 단일 소스이고, `setCurrentChatRoom(updater)`로 현재 방만 갱신한다.
- `src/components/ChatRoomView.tsx` — 가장 큰 파일. 실제 메시지 송수신, 스트리밍, 재생성/편집,
  메모리·로어북·RAG 파이프라인 호출을 전부 여기서 조율한다.
- `src/components/SettingsModal.tsx` — 방별 설정(모델, temperature/topP, 페널티, XTC,
  thinking 모드, role/output contract, 로어북 편집 등).
- `src/services/promptEngine.ts` — `PromptEngine`. `<role>`, `<output_contract>`, 메모리 슬롯,
  로어북, RAG 컨텍스트를 조립해 최종 프롬프트를 만든다.
- `src/services/memoryManager.ts` — `MemoryManager`. 응답에서 메모리 업데이트를 파싱해
  `MemorySlots`에 반영하고, short_term_memory를 RAG로 넘긴다.
- `src/services/lorebookService.ts` — `LorebookService`. 키워드/정규식/임베딩 유사도로
  로어북 엔트리를 트리거하고 depth(high/mid/low)별로 분류.
- `src/services/ragService.ts` — `RAGService`. 임베딩 기반 벡터 메모리 검색.
- `src/types.ts` — `ChatRoom`, `MemorySlots`, `LorebookEntry`, `VectorMemoryChunk` 등 핵심 타입.
- `src/constants.ts` — `DEFAULT_ROLE_DEFINITION`, `DEFAULT_OUTPUT_CONTRACT`,
  `DEFAULT_THINKING_MODE_INSTRUCTIONS` 등 기본 프롬프트 문자열.

경로 별칭 `@/` → `src/`.

## 데이터 영속화

서버·DB가 없다. 모든 상태가 브라우저 localStorage에 있다:

- `chatRooms` — 전체 채팅방 배열 (메시지, 메모리, 로어북, 벡터 메모리, 스냅샷 포함)
- `lastChatRoomId`, `theme`
- `filterSettings` — 출력 필터 토글. 방이 아니라 보기 설정이라 전역이다.

**스와이프(응답 후보).** `Message.variants`에 후보 목록, `activeVariant`에 선택 번호를 둔다.
`Message.text`/`thinking`/`ragContext` 등은 **항상 선택된 후보의 값**이라 렌더링 코드는
후보 존재를 몰라도 된다. 재생성은 메시지를 갈아치우지 않고 후보를 추가한다.
후보마다 메모리 결과가 다르므로 `MessageVariant.memory`에 스냅샷을 함께 담는다.

**분기 롤백은 출처 태깅으로 처리한다.** `LorebookEntry`와 `VectorMemoryChunk`의
`sourceMessageId`가 그 항목을 만든 AI 메시지를 가리킨다. 재생성·삭제·편집 시
`ChatRoomView`의 `pruneBranchArtifacts`가 사라진 메시지의 항목을 걷어내고,
`rollbackSnapshots`가 스냅샷과 메모리를 되돌린다. `sourceMessageId`가 없으면
수동 생성으로 보고 보존한다. 스냅샷에 로어북·벡터 메모리 전체를 복사하면
임베딩 때문에 localStorage 용량이 금방 터지므로 이 방식을 쓴다.

태그 형식은 `<메시지id>#<후보번호>`다 (`variantKey`). 스와이프 도입 전 데이터는
`#번호`가 없는데 `normalizeKey`가 0번 후보로 본다. **선택되지 않은 후보의 산출물은
지우지 않고 `selectActiveArtifacts`가 프롬프트 주입 단계에서 걸러낸다** — 그래야
후보를 앞뒤로 오가도 복원된다. 삭제는 메시지가 사라질 때만 일어난다.

주의: `RAGService.queryMemory`는 넘긴 목록만 돌려주므로, 걸러낸 목록을 넘긴 뒤
반환값을 그대로 저장하면 제외된 청크가 삭제된다. 접근 횟수 갱신분만 원본에 머지해야 한다.

**`ChatRoom` / `MemorySlots` 스키마를 바꿀 때는 `App.tsx`의 마이그레이션 로직을 함께 고쳐야 한다.**
`App.tsx`에는 두 벌의 마이그레이션 코드가 있다 — 초기 로드용 `useEffect`와 `handleImportChat`
(JSON 파일 가져오기). 둘 다 `mapOldMemory`와 모델명 정규화를 중복으로 갖고 있으므로
한쪽만 고치면 조용히 어긋난다.

## 모델명

유효 모델은 `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-flash-image`.
그 외 값은 로드 시 `gemini-3.1-pro-preview`로 정규화된다 (`App.tsx`의 `modelName` 마이그레이션).
모델 목록을 추가할 때 `App.tsx`의 `validModels`와 `SettingsModal.tsx`의 선택 목록을 같이 바꾼다.

## 배포 (GitHub Pages)

`main`에 푸시하면 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)이 자동으로
빌드해서 배포한다. 폰에서는 이 배포본을 쓴다.

**주소: https://kimshouse-s.github.io/rp-/**

[vite.config.ts](vite.config.ts)의 `base`가 빌드일 때만 `/rp-/`가 된다. 하위 경로로
서비스되므로 이 값이 없으면 자산 경로를 못 찾아 흰 화면만 뜬다. 개발 서버는 루트를
써야 `localhost:3000`이 그대로 열리므로 `command === 'build'`로 구분한다.

**배포본에는 API 키를 넣지 않는다.** 번들에 박히면 사이트를 여는 누구나 볼 수 있다.
사용자가 설정에서 직접 입력하고 [apiKeys.ts](src/services/apiKeys.ts)가 브라우저에 저장한다.

배포본에서 쓸 수 있는 프로바이더는 `gemini`와 `openrouter`뿐이다. `claude`는 개발 서버의
`/api/chat`이 있어야 하므로 PC 전용이다.

`@anthropic-ai/claude-agent-sdk`는 개발 서버 전용이라 `devDependencies`에 있다.
클라이언트 번들에는 들어가지 않는다 (`claudeBridge`가 요청 시점에 동적 import 한다).

## 저장 용량

브라우저 저장소는 출처당 약 5MB다. `~.github.io`에 올리면 그 계정의 다른 Pages 사이트와
같은 출처라 용량을 나눠 쓴다.

벡터 메모리 청크의 임베딩이 용량을 가장 많이 먹는다. 그래서 `ragThreshold`가 0(기본값,
유사도 검색 미사용)이면 임베딩을 아예 만들지 않는다. 임베딩 생성이 실패해도 청크 자체는
저장한다 — 예전에는 여기서 기록을 통째로 버려서 Gemini 키가 없으면 장기 기억이 사라졌다.

## UI 언어

UI 문자열은 한국어다. 새 문자열도 한국어로 쓴다.
