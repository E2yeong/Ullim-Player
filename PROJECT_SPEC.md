# Ullim — 재현/재구축 명세서

> 앱 이름은 **Ullim**(울림)이지만, GitHub 저장소는 처음 만들었을 때 이름 그대로
> `E2yeong/music-player-pro`를 계속 쓰고 있다 (저장소 이름 변경은 별도로 하지 않음).
> `package.json`의 `name`/`productName`은 `ullim`/`Ullim`, `appId`는 `com.local.ullim`.

이 문서는 이 프로젝트를 처음부터 다시 만들어야 할 때(다른 PC, 다른 이름, 다른 저장소 등) 참고할 수 있도록
기능·아키텍처·설정 방법을 정리한 문서입니다. 코드를 직접 읽지 않아도 이 문서만 보고 동일한 앱을
재구성할 수 있는 것을 목표로 합니다.

## 1. 한 줄 요약

로컬 mp3/mp4 파일을 재생하는 Windows 데스크톱 앱(Electron). 좌측 아이콘 레일 + 탭(목록/재생/EQ/설정)
구조의 메인 창, 플레이리스트, 반복/셔플, 8밴드 그래픽 EQ, 리버브, 항상 위에 뜨는 미니 플레이어(오버레이),
시스템 트레이 백그라운드 재생, 설정 자동 저장/복원, GitHub Releases 기반 자동 업데이트를 갖춤.

## 2. 기술 스택

- **Electron** (`electron`, `electron-builder`) — 데스크톱 앱 셸, Windows NSIS 인스톨러 빌드
- **순수 JS/HTML/CSS** — 프레임워크 없음 (React/Vue 등 미사용), 렌더러는 vanilla DOM 조작
- **Web Audio API** — `<video>` 엘리먼트를 오디오 소스로 사용해 mp3/mp4 모두 처리, EQ/리버브/리미터는
  `AudioContext` 그래프로 구성
- **electron-updater** — GitHub Releases(비공개 저장소)를 피드로 사용하는 자동 업데이트
- **music-metadata** (`music-metadata@7`, CommonJS 마지막 버전) — 메인 프로세스에서 ID3/MP4/Vorbis
  태그·앨범아트 읽기 (§4.14). v8+는 순수 ESM이라 `require()`가 안 되므로 7.x에 고정
- **GitHub CLI(`gh`)** — 저장소 생성, 릴리스 업로드/공개에 사용 (사람이 미리 `gh auth login` 해둬야 함)

## 3. 폴더 구조

```
Music_pro/                # 로컬 프로젝트 폴더명(디스크상 이름). 앱 표시 이름은 Ullim.
  package.json          # electron-builder 설정(build 필드) 포함
  update-token.txt       # (git에 없음) private repo 읽기 전용 fine-grained PAT, 로컬에만 존재
  build/
    icon.ico              # 앱 아이콘 (창/트레이/설치파일 아이콘 전부 이 파일 하나로 사용)
  assets/
    Ullim_intro.mp4        # 실행 시 재생되는 인트로 영상 (git에 커밋됨, extraResources로 배포)
  src/
    main.js               # Electron 메인 프로세스 (창 생성, IPC, 트레이, 자동 업데이트, 설정 파일 I/O)
    preload.js             # 메인 창용 contextBridge API (window.api)
    preload-overlay.js      # 오버레이 창용 contextBridge API (window.overlayApi)
    preload-splash.js       # 인트로 영상 창용 contextBridge API (window.splashApi)
    renderer/
      index.html            # 좌측 아이콘 레일 + 4개 탭(목록/재생/EQ/설정) + 하단 고정 트랜스포트 바
      style.css
      renderer.js          # 메인 창 전체 로직 (탭 전환, 재생, 플레이리스트, EQ, 설정 저장/복원, 업데이트 UI)
    overlay/
      index.html
      overlay.css
      overlay.js           # 항상 위 미니 플레이어 로직
    splash/
      index.html
      splash.js             # 인트로 영상 재생, 종료/건너뛰기 시 메인 창에 바통 전달
```

## 4. 핵심 기능 (동작 방식 포함)

### 4.1 재생 / 플레이리스트
- `<video>` 태그 하나로 mp3/mp4/wav/ogg/m4a/flac/webm 재생. mp4가 아니면 커버 아트 오버레이(♪ 아이콘)를
  씌워 검은 화면 대신 보여줌 (`videoWidth === 0`이면 오디오로 간주).
- 파일 경로는 `file:///...` 로 변환해 `mediaEl.src`에 대입 (공백/한글 등은 `encodeURI` 처리).
- 이전/다음/반복(끄기→전체→한곡 순환)/셔플, 재생목록 클릭 재생, 개별 삭제, 전체 삭제, 드래그 앤 드롭 추가.
- 좌측 사이드바에 여유 있는 밀도의 리스트(번호 / 제목·아티스트 2줄 / 길이)로 표시 (§4.12 "정석안" 참고).
  제목·아티스트는 ID3 태그가 있으면 그것을, 없으면 파일명을 씀 (§4.14).
- **라이브러리 + 멀티 재생목록** (§4.15): 사이드바 상단 탭으로 "전체 곡"(라이브러리) ↔ 사용자 재생목록 전환.
- **실시간 검색/필터** (§4.16): 재생목록 탭 바로 아래 검색창, 지금 보고 있는 목록(라이브러리든
  재생목록이든) 안에서 제목/아티스트/앨범을 즉시 필터링.
- **시인성 개선** (2026-09-10): 현재 재생 곡 강조를 어두운 배경색 정도에서 → 채워진 왼쪽 액센트
  바 + 굵은 글씨로 강화. 재생목록/EQ/설정 등 전반의 회색 보조 텍스트 대비를 올리고
  (`color-mix` 투명도 값들을 대체로 +12~15pt), 사이드바 폭 안에서 오버플로 없이 폰트 크기와
  `--space-*` 간격 토큰을 한 단계씩 키움.

### 4.15 라이브러리 + 멀티 재생목록

- **모델**: `state.library`(모든 임포트된 트랙 객체) + `state.playlists`(`[{id, name, paths:[]}]`,
  paths는 라이브러리 경로 참조) + `state.activePlaylistId`(`'library'` 또는 재생목록 id — 보이는
  목록이자 이전/다음이 순회하는 목록). `state.tracks`는 **파생값** — `rebuildActiveList()`가 활성
  목록을 실제 배열로 만들어 두어서 나머지 플레이어 코드는 예전처럼 인덱싱만 하면 됨.
  `state.currentPath`가 로드된 트랙의 안정적 식별자(재생목록 전환에도 유지), `currentIndex`는 그
  경로의 `state.tracks` 내 위치로 매번 재계산.
- **탭 UI**: `#playlistTabs`에 칩 렌더. "전체 곡"은 항상 첫 번째(삭제 불가). `+` 칩으로 새로 만들면
  바로 인라인 입력(`.pl-tab-edit`)으로 이름 편집(blur/Enter 커밋, Escape 취소). 칩 더블클릭 = 이름
  변경, hover 시 ✕ = 삭제(곡 1개 이상이면 `confirm`, 곡은 라이브러리에 남음).
- **곡 → 재생목록 담기**: 라이브러리 뷰의 각 행에 `＋` 버튼 → `<body>`에 뜨는 작은 팝업 메뉴
  (`.row-menu`)에서 재생목록 선택 또는 "+ 새 재생목록". 이미 담긴 재생목록엔 `✓` 표시.
- **행 ✕**: 라이브러리 뷰 = 라이브러리에서 완전 삭제(+ 모든 재생목록에서도 제거). 재생목록 뷰 =
  그 재생목록에서만 빼기(라이브러리엔 유지).
- **순서 변경**: 재생목록 뷰에서만 `li` HTML5 draggable로 드래그 정렬(`reorderInPlaylist`).
- **"전체 삭제" 버튼**: 라이브러리 뷰 = 전부 삭제, 재생목록 뷰 = "목록 비우기"로 라벨/동작 전환.
- **설정 마이그레이션**: `load-settings`(main.js)가 옛 `{tracks, currentIndex}` → `{library,
  playlists, activePlaylistId, currentPath}`로 변환하고, 파일이 사라진 트랙을 걸러낸 뒤 그 경로를
  모든 재생목록·`currentPath`에서도 정리. `writeSettingsFile`은 `library`가 자리잡은 뒤엔 옛
  `tracks`/`currentIndex` 키를 제거(shallow merge가 계속 끌고 오는 것 방지).
- 길이(재생시간)는 파일을 재생하지 않고도 표시하기 위해, 트랙이 추가될 때마다 화면에 붙이지 않는
  `<video preload="metadata">`를 하나 만들어 `loadedmetadata`에서 duration만 읽고 버리는 방식으로
  비동기 조회함 (`probeDuration()`). DOM에 붙이지 않는 엘리먼트라 GC가 로딩 중에 수거해갈 수 있어,
  로딩이 끝날 때까지 `Set`에 참조를 붙잡아둠. 조회된 `durationSec`은 `state.tracks`의 트랙 객체에 그대로
  얹혀서 설정 파일에도 같이 저장되므로, 한 번 조회된 곡은 다음 실행부터 다시 조회하지 않음.

### 4.16 실시간 검색/필터

- **범위**: 지금 보고 있는 목록(라이브러리 또는 특정 재생목록) 안에서만 필터링 — 전체 라이브러리를
  가로질러 찾고 싶으면 먼저 "전체 곡" 탭으로 이동. `#searchInput`의 `input` 이벤트마다
  `state.filterQuery`를 갱신하고 `renderPlaylist()`를 다시 호출하는, 순수 뷰 레이어 필터.
- **매칭**: `trackMatchesQuery()`가 파일명 + ID3 title/artist/album(있으면)을 합쳐 소문자
  부분일치로 검사 — 태그가 없는 곡도 파일명으로는 찾을 수 있다.
- **재생목록 상태와 분리**: `state.tracks`(활성 목록 전체)는 필터와 무관하게 그대로 유지되고,
  `renderPlaylist()`가 화면에 그릴 때만 걸러진 부분집합을 계산한다. 그래서:
  - 이전/다음 곡 재생은 필터와 상관없이 활성 목록 전체를 순회한다(필터는 찾기용이지 재생 큐를
    바꾸지 않음).
  - 각 행은 `state.tracks.indexOf(track)`로 실제 인덱스를 구해서 `loadTrack`/`removeTrack`에
    넘기므로, 화면에 몇 번째로 보이든 정확한 트랙이 재생/삭제된다.
  - 필터가 걸려 있는 동안은 드래그 정렬을 비활성화(화면상 이웃이 실제 재생목록 순서상 이웃이
    아닐 수 있어 혼란스러움).
- **세션 전용**: `state.filterQuery`는 설정 파일에 저장하지 않음 — 검색창은 매번 비어서 시작.

### 4.17 다이나믹 컬러 테마 (앨범아트 기반)

- **추출 위치 — 반드시 메인 프로세스**: 처음엔 렌더러에서 `<canvas>` + `HTMLImageElement.decode()`로
  구현했으나, 이 앱의 렌더링 파이프라인에서 `decode()`가 간헐적으로 멈추거나("The source image
  cannot be decoded") 그냥 응답을 안 하는 문제가 있었다 — 트랙이 빠르게 바뀔 때뿐 아니라 유휴
  상태에서도 재현됨(§7의 "실제 디스플레이 세션 없음" 환경 제약과 같은 계열). `nativeImage.toBitmap()`은
  동기적이고 안정적이라, 추출 전체를 `read-metadata`가 앨범아트를 읽는 그 자리(main.js)에서 끝내고
  `{r,g,b}`를 `themeColor` 필드로 같이 반환하도록 옮겨서 해결 — 렌더러는 그 값을 그대로 CSS 변수에
  꽂기만 한다.
- **버그였던 것 — BGRA vs RGBA**: 디버깅 중 "빨간" 테스트 이미지가 파랗게 추출되는 것처럼 보인
  순간이 있었는데, 실제 원인은 `nativeImage.createFromBuffer(buf, {width,height})`가 원시 버퍼를
  **BGRA**로 해석한다는 점(RGBA 아님) — 테스트 픽스처를 RGBA로 채워서 생긴 착시였고, 실제
  `extractThemeColor()`는 `toBitmap()`이 돌려주는 BGRA 순서를 이미 올바르게 반영하고 있었다.
  (`buf[i]=B, buf[i+1]=G, buf[i+2]=R`.)
- **추출 방법**: 앨범아트 `nativeImage`를 48px로 축소 → `toBitmap()`(BGRA) 순회하며 단순 평균 →
  `clampThemeColor()`가 RGB→HSL 변환 후 채도 35~62%, 명도 32~50%로 클램프하고 다시 RGB로 변환.
  거의 검정이거나 네온처럼 쨍한 커버라도 은은한 앰비언트 색으로 정리되게 하려는 목적.
- **적용 범위 — 장식 요소에만, 인터랙티브 요소는 그대로**: `--dyn-tint`/`--dyn-glow` 두 CSS 커스텀
  프로퍼티를 `document.documentElement`에 설정 → `.cover-art`의 라디얼 그라데이션과 `.stage`의
  앰비언트 `box-shadow` 글로우, 그리고 파형 캔버스의 그라데이션/글로우 색(`waveGradientTop/Bottom`,
  `waveGlowColor`, `updateWaveformPalette()`)이 이 값을 읽는다. 버튼·슬라이더·탭·현재곡 강조 같은
  인터랙티브 크롬은 의도적으로 건드리지 않음 — 추출색이 항상 예쁘게 나온다는 보장이 없어서, 어떤
  트랙을 틀어도 조작 가능한 요소는 항상 같은 색으로 신뢰감 있게 보이도록 유지.
  둘 다 CSS `var(--dyn-tint, <기존 고정값>)` 형태의 폴백을 가지고 있어 앨범아트가 없거나 추출 실패
  시 자동으로 예전 모습으로 돌아간다.
- **트랙 전환**: `loadArtForTrack()`이 그림이 있으면 `applyThemeColor(m.themeColor || null)`, 그림이
  없거나 트랙이 바뀌면 `clearAlbumArt()`가 `applyThemeColor(null)`로 초기화. `artLoadToken`으로
  빠른 트랙 전환 시 오래된 응답이 새 트랙의 색을 덮어쓰지 않게 방지.

### 4.2 EQ / 리버브 (Web Audio 그래프)
신호 경로:
```
MediaElementSource
  → [8개 BiquadFilter 직렬: 60Hz(lowshelf), 150, 400, 1K, 2.5K, 6K, 12K, 16Hz(highshelf)]
  → dryGain(0.92 고정) ─┐
  → ConvolverNode(wetGain) ┴→ masterGain → DynamicsCompressor(리미터) → destination
```
- 각 밴드 게인 범위: **-36dB ~ +36dB**
- 리버브: `ConvolverNode.buffer`는 1.4초 길이의 랜덤 노이즈를 decay 지수로 감쇠시켜 즉석 생성(외부 IR 파일
  없음). `wetGain`은 슬라이더 0~100%를 **그대로** wet 게인(0~1)에 매핑 (100%까지 완전 반영).
  dry는 항상 0.92로 고정 — **리버브를 올려도 원음 볼륨이 줄지 않도록** 하기 위함 (초기 버전 버그: dry를
  `1 - wet*0.6`으로 깎아서 리버브 올릴수록 전체 음량이 작아지고 먹먹해졌던 문제를 고침).
- 리미터(DynamicsCompressor): threshold -10dB, knee 4, ratio 20:1, attack 3ms, release 250ms.
  ±36dB 부스트를 여러 밴드에 동시에 걸어도 하드클리핑되지 않도록 하는 안전장치.
- EQ 프리셋 4종(Flat/Bass Boost/Vocal/Hall Reverb)은 8개 밴드 게인 배열 + reverb% 값의 조합으로 정의.

### 4.3 오버레이(미니 플레이어)
- 별도의 frameless, `alwaysOnTop: true` (level `'screen-saver'`), `transparent: true` BrowserWindow.
- `resizable: true`, `minWidth/minHeight/maxWidth/maxHeight` 지정, 우하단에 시각적 리사이즈 그립 표시
  (실제 리사이즈는 OS 창 경계 드래그로 동작, 그립은 장식용).
- 위치/크기는 `player-settings.json`의 `overlayBounds`에 저장되어 다음에 열 때 복원됨. 모니터 구성이
  바뀌어도 화면 밖으로 나가지 않도록 `workArea` 기준으로 clamp.
- 메인 창과는 IPC로 상태를 주고받음 (재생 여부, 곡 제목, 볼륨, 재생 위치/길이) — 오버레이에서 버튼을
  누르면 커맨드를 메인 창에 보내고, 메인 창이 실제 재생을 제어한 뒤 상태를 다시 브로드캐스트.
- 진행바 포함 (탐색 가능): 메인 창이 재생 중 500ms 간격으로 `currentTime/duration`을 브로드캐스트.

### 4.4 시스템 트레이 (백그라운드 재생)
- 창의 X(닫기) 버튼을 누르면 기본적으로 **종료가 아니라 숨김**(`e.preventDefault(); mainWindow.hide()`).
  이 동작은 "설정" 탭의 "닫아도 트레이에 상주" 토글로 끌 수 있음 — 꺼져 있으면 `close` 이벤트에서
  `preventDefault()`를 호출하지 않아 평범하게 종료됨. 매번 닫을 때마다 `readSettingsFile()`을 새로 읽어
  판단하므로 앱을 재시작하지 않고 설정만 바꿔도 바로 반영됨.
- 실제 종료는 트레이 메뉴의 "종료"(`app.isQuitting = true; app.quit()`)나 `before-quit` 이벤트를 통해서만.
- 트레이 메뉴: 열기 / 재생·일시정지 / 다음 곡 / 이전 곡 / 종료. 트레이 아이콘 클릭 시 창 show/focus.
- 창이 숨겨져 있어도 렌더러 프로세스는 계속 살아있으므로 재생은 백그라운드에서 계속되고, 오버레이로
  계속 제어 가능.

### 4.5 설정 자동 저장/복원
- 저장 위치: `app.getPath('userData')/player-settings.json` (Windows: `%APPDATA%\<productName 소문자>\`)
- 저장 항목: `tracks`(경로+이름+`durationSec` 배열), `currentIndex`, `repeatMode`, `shuffle`, `eqEnabled`,
  `waveformEnabled`, `currentPreset`(마지막으로 적용한 EQ 프리셋 key, 수동으로 슬라이더를 만지면 `null`),
  `trayOnClose`/`introEnabled`/`autoUpdateCheck`(§4.12 설정 탭 토글 3종), `volume`,
  `eq: { bands: number[8], reverb: number }`, `overlayBounds`.
- `trayOnClose`/`introEnabled`/`autoUpdateCheck`는 렌더러 쪽에는 UI 상태 표시 말고 다른 효과가 없고,
  **메인 프로세스(`main.js`)가 설정 파일을 직접 읽어** 동작을 바꾼다 — 별도 IPC 채널을 두지 않고, 그때그때
  `readSettingsFile()`을 호출해 최신 값을 읽는 방식 (창 닫기 핸들러, 스플래시 창 생성 직전, 앱 시작 시
  각각 한 번씩).
- **읽기-수정-쓰기(read-modify-write) 병합** 방식 (`writeSettingsFile`) — 렌더러가 부분 정보만 저장해도
  메인 프로세스가 직접 저장하는 `overlayBounds` 같은 필드를 덮어쓰지 않도록 항상 기존 파일을 읽어 병합
  후 저장.
- 앱 시작 시 저장된 트랙 경로 중 실제로 존재하지 않는 파일은 자동으로 목록에서 제외 (`fs.existsSync`).
- **이름 변경 시 마이그레이션 필요**: `userData` 경로는 `package.json`의 `name` 필드를 따라가므로
  (`%APPDATA%\<name>`), 앱 이름을 바꾸면(`music-player-pro` → `ullim`) 예전 설정 파일을 못 찾게 된다.
  `migrateOldSettingsIfNeeded()`가 새 경로에 파일이 없을 때만 옛 폴더(`music-player-pro`)의
  `player-settings.json`을 한 번 복사해 옴 — 이름을 또 바꾸게 되면 이 함수의 옛 경로도 갱신할 것.
- 렌더러의 각 상태 변경 지점(EQ 슬라이더, 볼륨, 반복/셔플, 트랙 추가/삭제/재생)마다 400ms 디바운스로
  저장, 창 종료(`beforeunload`) 시 즉시 flush.

### 4.6 자동 업데이트 (electron-updater + GitHub Releases, private repo)
- **왜 private repo인가**: 개인용 프로젝트라 코드 비공개 유지. 단, private repo면 electron-updater가
  API 인증 토큰을 요구함.
- **토큰 취급 원칙**: 넓은 권한의 개인 `gh` 로그인 토큰을 앱에 박아넣지 않고, **Fine-grained PAT**를
  발급해서 사용 — 대상 저장소 단 하나, `Contents: Read-only` 권한만 부여. 이 토큰 값은:
  - 절대 git에 커밋하지 않음 (`update-token.txt`를 `.gitignore`에 등록)
  - electron-builder의 `extraResources`로 패키징된 앱의 `resources/update-token.txt`에 포함시켜 배포
  - 메인 프로세스가 앱 시작 시 파일에서 읽어 `autoUpdater.setFeedURL({ provider:'github', owner, repo,
    private:true, token })`로 전달
  - **중요한 함정**: `electron-updater`는 private GitHub repo 인증 토큰을 `autoUpdater.requestHeaders`가
    아니라 **`setFeedURL()`의 `token` 필드**로 받아야 인식한다 (내부적으로 `PrivateGitHubProvider`를
    선택하는 조건이 `providerFactory.js`에서 `data.private`이고 `GH_TOKEN`/`GITHUB_TOKEN` 환경변수 또는
    `data.token`이 있을 때임). `requestHeaders`로만 설정하면 조용히 공개용(GitHubProvider, 인증 없음)
    provider로 폴백되어 private repo에서 404가 난다.
- **업데이트 확인 흐름**: 메인 창의 "업데이트 확인" 버튼 → `checkForUpdates()` → available이면 버튼이
  "vX.X.X 다운로드"로 바뀜 → 클릭 시 `downloadUpdate()` → 완료되면 "재시작 후 설치" → `quitAndInstall()`.
  개발 모드(`app.isPackaged === false`)에서는 업데이트 확인을 하지 않고 안내 메시지만 표시.
- **시작 시 자동(조용한) 확인**: "설정" 탭의 "자동 업데이트 확인" 토글이 켜져 있으면(기본값), 패키징된
  앱은 `app.whenReady()` 직후 `autoUpdater.checkForUpdates()`를 한 번 더 호출한다. 수동 버튼과 완전히
  같은 `autoUpdater` 이벤트(`checking-for-update`/`update-available`/...)를 그대로 타므로 렌더러 쪽에는
  새 IPC나 분기 없이 동일하게 반영됨 — "자동으로 조용히 확인"이라는 문구와 달리 실제로는 수동 확인과
  똑같이 상태 UI가 갱신되는데, 새 버전이 없으면 어차피 "최신 버전입니다" 정도라 눈에 띄지 않을 뿐임.

### 4.7 실행 시 인트로 영상
- "설정" 탭의 "시작할 때 인트로 영상" 토글이 꺼져 있으면 `createSplashWindow()`가 스플래시 창을 아예
  만들지 않고 곧바로 `onDone()`을 호출해 메인 창을 보여줌 — 인트로 관련 코드 경로 자체를 건너뜀.
- 앱이 콜드 스타트할 때(트레이에서 창을 다시 열 때는 X) `assets/Ullim_intro.mp4`를 재생하는 별도의
  frameless 스플래시 창을 먼저 띄움. 메인 창은 `show:false`로 미리 생성해두고, 영상이 끝나거나
  ("ended"/"error" 이벤트) 사용자가 "건너뛰기"를 누르면 스플래시 창을 닫고 메인 창을 보여줌.
- 영상이 20초 안에 끝나지 않으면(코덱 문제 등) 안전장치 타이머로 자동으로 건너뜀.
- 영상 파일은 `app.asar` 안에 넣으면 `<video src="file://...">` 로 재생이 안 될 수 있어(ASAR는 진짜
  디렉터리가 아니라서 Chromium의 미디어 로더가 직접 못 읽음) **asar 밖의 `extraResources`**로 배포함
  (`update-token.txt`와 같은 방식). 스플래시 창은 `data:` URL이 아니라 실제 `loadFile()`로 정적
  `src/splash/index.html`을 불러오고, 영상 경로는 `get-intro-video-url` IPC로 받아온다
  (`data:` URL은 오리진이 분리되어 `file://` 리소스를 못 불러올 수 있어서 피함).

### 4.8 EQ 확장 히스토리 (참고)
1. 처음엔 Bass/Mid/Treble 3밴드, ±15dB — "악기별 자동 부스트/감쇠" 요청이 있었으나, 주파수 대역 기반
   EQ는 그 대역의 모든 소리(보컬 포함)에 동일하게 적용되어 보컬도 같이 줄어드는 한계가 있어 **실시간
   AI 음원 분리(악기별 감지)는 채택하지 않음** — 대신 8밴드로 세분화.
2. 최종: 8밴드(60/150/400/1K/2.5K/6K/12K/16K), ±36dB, 리버브 최대 100% wet, 리미터로 안전장치.

### 4.9 파형(waveform) 비주얼라이저 — 앱 이름("울림")을 시각화한 시그니처 기능
- `masterGain`에서 `AnalyserNode`(fftSize 512, smoothing 0.8)를 탭으로 분기 연결 (오디오 경로 자체에는
  영향 없음, 시각화 전용). 주파수 데이터(`analyserData`, 전체 레벨용)와 시간 도메인 데이터
  (`waveformData`, 파형 모양용)를 둘 다 사용.
- **모양은 위/아래로 미러링된 리본이 아니라 단일 파형** — 바닥에서 솟아오르는 하나의 곡선(산맥
  실루엣 느낌)이다. `getByteTimeDomainData()`를 `WAVE_POINTS`(48)개 구간으로 나눠 각 구간의 최대
  진폭을 뽑고, 그 값을 "envelope" 배열에 저장 — 새 값이 크면 즉시 튀어오르지만 작으면
  `WAVE_DECAY`(0.93)씩만 감쇠시켜서 **파형이 순간적으로 사라지지 않고 잔상처럼 오래 남도록** 만듦
  (맨 처음엔 매 프레임 즉시 사라지는 원형 ripple 이었다가 "더 오래갔으면"이라는 피드백으로 감쇠 방식
  으로 바꿨고, 그 다음엔 이 envelope을 위/아래로 미러링해 리본처럼 그렸다가 "2갈래로 갈라져 보인다"는
  피드백을 받고 최종적으로 지금의 단일 곡선 형태가 됨). `tracePath()`로 부드러운 곡선
  (`quadraticCurveTo`)을 그린 뒤 바닥까지 내려와 닫힌 도형으로 채우고, 보라색 그라데이션 + glow +
  위쪽 가장자리에만 밝은 stroke를 얹어 그림.
- 커버아트 영역(`#coverArt`)에 `<canvas>`로 그려짐. 오디오 전용 재생 시엔 항상 이 영역이 보이고,
  mp4 재생 시엔 기본적으로 실제 영상이 보임 — **단, `#btnWaveToggle`(스테이지) 또는 설정 페이지의
  파형 토글을 사용자가 실제로 한 번이라도 클릭하면, 그 세션 동안은 그 마지막 선택(on/off)이 영상보다
  우선한다** (`userToggledWaveform` 세션 변수, 저장되지 않음 — 앱을 다시 켜면 mp4는 항상 자기 영상부터
  보여주는 기본값으로 돌아옴). 그냥 저장된 `waveformEnabled:true`가 기본값이라고 해서 mp4를 열자마자
  영상이 파형으로 가려지면 안 되기 때문에 이렇게 분리함 — `state.waveformEnabled` 자체는 여전히
  "파형을 그릴지"만 뜻하고, `userToggledWaveform && state.waveformEnabled`가 "영상 대신 파형을 보여줄지"
  를 결정한다. 두 버튼(스테이지의 🌊, 설정의 토글) 모두 클릭 시 `userToggledWaveform = true`를 세팅한
  뒤 `setWaveformEnabled()`를 호출한다 — `setWaveformEnabled()` 자체(설정 복원 시에도 호출됨)는 이
  플래그를 건드리지 않아서, 저장된 설정을 불러오는 것만으로는 영상이 가려지지 않는다.
- `mediaEl`의 `play`/`pause` 이벤트로 `requestAnimationFrame` 루프를 시작/정지 (재생 중이 아닐 때는
  그리지 않아 CPU 낭비 없음, `waveformEnabled`가 꺼져 있으면 애초에 시작 안 함).
- 오버레이의 작은 점(dot)도 같은 컨셉으로 동기화됨: 전체 레벨을 100ms 간격으로 별도의 가벼운 IPC
  채널(`player-level-update`→`level-update`)로 오버레이에 전달해서 `transform: scale()` + 글로우로
  박동시킴. 곡 제목/진행률 등을 담는 무거운 `player-state-update`와 분리해서 빈도를 높게 유지.

### 4.10 오버레이 EQ/리버브 미니 패널
- 오버레이를 세로로 크게 리사이즈하면(`window.innerHeight >= 260`) 숨겨져 있던 8밴드 미니 EQ +
  리버브 슬라이더가 나타남 (`.panel.expanded` 클래스 토글, `window`의 `resize` 이벤트로 감지).
  이 때문에 오버레이 최대 높이(`OVERLAY_MAX_HEIGHT`)를 320→420으로 늘림.
- 밴드 주파수/범위(±36dB)는 메인 창의 `EQ_BANDS`와 반드시 일치시켜야 함 — 빌드 시스템이 없어 상수를
  `src/overlay/overlay.js`에도 그대로 복붙해둔 상태라, 메인 쪽 EQ 대역을 바꾸면 여기도 같이 고칠 것.
- 양방향 동기화: 오버레이에서 슬라이더를 움직이면 `overlay-command`(`eq-band`/`eq-reverb`)로 메인에
  전달되어 실제 EQ에 반영되고, 메인 창에서 슬라이더를 움직이면 `broadcastState()`가 `eq:{bands,reverb}`를
  포함해 오버레이에 다시 뿌려줌 — 두 방향 다 빠짐없이 `broadcastState()`를 호출하도록 되어 있는지 주의
  (한쪽만 빠뜨리면 창이 떠 있는 동안 서로 다른 값을 보여주는 버그가 남).

### 4.11 알려진 버그(해결됨): 트레이 아이콘이 투명하게 보이던 문제
- **진짜 원인**: `build/` 폴더는 electron-builder가 exe/설치파일 아이콘을 만들 때만 쓰는 폴더라서,
  **패키징된 앱에는 아예 포함되지 않는다.** 그런데 `createTray()`가 런타임에
  `path.join(__dirname, '..', 'build', 'icon.ico')`를 직접 읽으려고 했으니, 설치된 앱에서는 그 경로에
  파일이 없어 `nativeImage`가 빈 이미지를 반환 → `Tray`가 빈(투명한) 아이콘으로 뜸. 개발 모드(`npm start`)
  에서는 `build/`가 프로젝트 폴더에 실제로 있어서 이 버그가 재현되지 않았던 것도 원인 파악을 늦춘 요인.
  (처음엔 "256px 프레임을 그대로 써서 안 보인다"고 잘못 진단하고 `.resize({width:16,height:16})`만
  적용했었는데, 그건 진짜 원인이 아니었음 — 파일 자체가 없었으니 리사이즈해도 여전히 빈 이미지였음.)
- **해결**: `build/icon.ico`와 트레이 전용 `build/tray-icon.png`를 `package.json`의 `extraResources`에
  추가해서 실제로 패키징되게 하고, `getPackagedAsset(filename, devSubdir)` 헬퍼로 packaged/dev 경로를
  일관되게 처리 (§6의 업데이트 토큰/인트로 영상과 동일한 패턴). **런타임에 `fs`나 `nativeImage`로 읽는
  파일은 전부 이 헬퍼를 거치거나 `extraResources`에 등록되어 있는지 확인할 것** — 새 애셋을 추가할 때
  가장 흔하게 반복될 만한 실수.
- 트레이 아이콘은 `build/icon.ico`(멀티 사이즈)를 런타임에 리사이즈하지 않고, 미리 32×32로 렌더링해둔
  `build/tray-icon.png`를 그대로 사용 — 멀티 프레임 `.ico`에서 프레임을 골라 리사이즈하는 것보다 훨씬
  예측 가능함.

### 4.12 UI 레이아웃 재설계 — "정석안"(1a) + 설정만 분리하는 레일(1b) + Nocturne 디자인 토큰
UI 목업(Claude Design 캔버스, `Ullim app UI mockups/` 폴더 — 특히 `_ds/nocturne-*/styles.css`가
실제 디자인 시스템 소스)을 검토하고 처음엔 "레일 + 4개 탭(목록/재생/EQ/설정)"으로 전부 분리했었는데,
사용자 피드백("한 화면에 다 있고 여유 있는 밀도였으면 좋겠다")을 받고 최종적으로는 **목업의 1a
안(좌: 재생목록 / 우: 스테이지+EQ, 전부 한 화면)을 기본 레이아웃으로 유지하면서, 레일은 "설정" 화면
하나만 분리해서 꺼내는 용도로만 쓰는** 형태로 정리했다.

- **구조**: `.app` = `.rail`(좌측 아이콘 60px) + `.pages`(나머지 전체). `.pages` 안에 `#pageMain`(기본,
  1a 그대로: 사이드바 재생목록 + 스테이지/파형 + 탐색바 + 재생 컨트롤 + EQ 패널이 전부 한 화면)과
  `#pageSettings`(§4.5의 토글 4개 + 버전/업데이트 확인) 두 개만 존재. 레일 버튼은 `data-page` 속성이
  있는 것만 페이지 전환 대상이고(홈/설정), 오버레이 핀 버튼은 `data-page`가 없어서 전환 로직에서
  자동으로 제외됨.
- **페이지 전환은 클래스로, `hidden` 속성은 쓰지 않음**: `.page { display:none } .page.active
  { display:flex }` 처럼 클래스 기반으로 전환한다. 첫 시도 때는 `hidden` 속성 + `.tab-view{display:flex}`
  조합을 썼다가 실제로 화면에 4개가 전부 겹쳐 보이는 버그가 났었다 — **원인은 `[hidden]{display:none}`이
  브라우저 기본(user-agent) 스타일시트 규칙이라, author 스타일시트의 `.tab-view{display:flex}`가
  명시도(specificity)와 무관하게 항상 그것보다 우선 적용되기 때문**이었다. 클래스 기반 토글은 이 origin
  우선순위 문제 자체가 없어서 재발 위험이 없다.
- **Nocturne 디자인 토큰**: `src/renderer/style.css`와 `src/overlay/overlay.css` 양쪽 다 `:root`에
  같은 토큰을 하드코딩해서 갖고 있음 (두 창은 별도 문서라 CSS 커스텀 프로퍼티를 공유할 수 없음) —
  `--color-bg:#161826`, `--color-surface:#232532`, `--color-text:#e9e9ed`, `--color-accent:#9184d9`
  등. 구글 폰트(Inter)는 이 앱의 CSP(`style-src 'self' 'unsafe-inline'`, 외부 origin 예외 없음)로는
  로드할 수 없어서 `"Inter", "Segoe UI", ...` 폴백 스택으로 근사함. 버튼도 목업의 `.btn`/`.btn-primary`
  등 컴포넌트 클래스를 그대로 이식 — 꽉 찬 배경색 버튼이 아니라 테두리만 있다가 hover 시 액센트 컬러가
  옅게 깔리는 outline 스타일.
- **아이콘은 이모지가 아니라 인라인 SVG**: 재생/일시정지/이전/다음/셔플/반복/볼륨/홈/설정/핀/닫기 전부
  얇은 선(stroke) 또는 단색 채움 SVG로 통일 (main.js가 아니라 각 window의 index.html/renderer.js에
  하드코딩된 마크업 — 아이콘 폰트 CDN은 CSP상 불러올 수 없어서 직접 그림). 재생/일시정지처럼 상태에 따라
  바뀌는 아이콘은 `PLAY_ICON`/`PAUSE_ICON` 문자열을 버튼의 `innerHTML`에 갈아끼우는 방식
  (`setPlayIcon()` in renderer.js, 오버레이는 overlay.js에 동일 패턴 복붙).
- **CSS 주석 안에 `*/` 를 절대 넣지 말 것 (실제로 겪은 버그)**: `style.css` 맨 위 설명 주석에 목업 파일
  경로(`nocturne-*/styles.css`)를 그대로 적었다가, 그 안의 `*/`가 주석을 조기 종료시켜 `:root{...}`
  색상 변수 블록 전체가 파서에 의해 통째로 버려지는 사고가 있었다. 결과: 텍스트는 전부 브라우저 기본값인
  검은색으로, 배경만 `BrowserWindow`의 네이티브 `backgroundColor` 옵션(CSS와 무관) 때문에 어두운 색으로
  남아 "글씨가 안 보인다"는 증상으로 나타났다. `document.styleSheets[0].cssRules`에서 `:root` 규칙이
  통째로 빠져 있는지 확인하면 이 클래스의 버그를 바로 잡아낼 수 있다. 재현 시 CSS 파일 안에 아무 텍스트나
  자유롭게 쓰지 말고, 특히 파일 경로/글롭 패턴처럼 `*`와 `/`가 인접할 수 있는 문구는 주석에서 피할 것.
- **EQ 슬라이더 — 여러 번 갈아엎은 끝에 "그냥 진짜 `<input>`을 돌려서 쓰기"로 정착함**:
  1. 처음엔 `-webkit-appearance: slider-vertical` — 네이티브 동그란 손잡이가 커스텀 손잡이 아래에
     겹쳐 보이는 버그.
  2. `writing-mode: vertical-lr` + `accent-color`(네이티브 테마 위임)로 교체 — 오버레이의 짧은 트랙에서
     네이티브 손잡이가 과하게 커 보이는 문제, 반투명 오버레이 창이 다른 배경(흰 화면 등) 위에 떠 있을
     때 트랙 자체가 잘 안 보이는 문제.
  3. 진짜 `<input>`은 `opacity:0`으로 완전히 투명하게 만들어 드래그만 담당시키고, 그 위에 트랙/채움
     막대/원형 손잡이를 손으로 그린 `<div>` 3개를 겹쳐 그리는 방식으로 교체 — 시각적으로는 의도대로
     나왔지만 **실제 마우스 드래그로 조작이 전혀 안 되는 회귀**가 발생함 (`writing-mode` +
     `-webkit-appearance:none` + `opacity:0` 조합에서 이 Chromium 빌드가 포인터 위치를 값으로 제대로
     추적하지 못한 것으로 보임 — 정확한 원인은 특정하지 못했음, 재현 시 이 조합을 피할 것).
  4. **최종**: 손으로 그리는 방식을 전부 걷어내고, 리버브/볼륨/탐색바와 완전히 동일한 방식의 진짜
     `<input type="range">`를 그냥 `transform: rotate(-90deg)`로 시각적으로만 90도 돌려서 씀
     (`.eq-slider-wrap input[type="range"]`, main/오버레이 동일 — `position:absolute; top:50%;
     left:50%; transform: translate(-50%,-50%) rotate(-90deg);`). 손잡이 모양·트랙 채움(`--fill`
     그라데이션)까지 전부 공용 `input[type="range"]` 규칙을 그대로 물려받으므로 커스텀 CSS가 필요 없고,
     `updateRangeFill()`(seek/volume/reverb와 공유) 한 함수로 전부 갱신된다. 브라우저는 CSS
     `transform`으로 회전된 엘리먼트에 대해서도 마우스 드래그 위치를 정확히 히트테스트하므로(내부적으로
     여전히 평범한 가로 슬라이더이고 화면에 그려지는 방식만 다름) 이 조합에서는 드래그가 문제없이
     동작한다 — **세로 슬라이더가 필요하면 `writing-mode`나 `slider-vertical`보다 이 `transform` 방식을
     먼저 시도할 것.** 오버레이의 미니 EQ는 패널 크기에 따라 트랙 길이가 유동적이라, 회전 전 `width`
     (=회전 후 세로 길이)를 CSS만으로 부모 높이에 맞출 수 없어서 `syncMiniSliderSizes()`
     (`overlay.js`)가 렌더링된 wrap의 `clientHeight`를 읽어 각 입력의 `width`에 픽셀 값으로 반영한다
     (패널이 펼쳐지거나 창 크기가 바뀔 때마다 재호출).
  - **CDP로 이 버그를 못 잡았던 이유**: 자동화 테스트에서 슬라이더 값 변경을 `input.value = x;
    input.dispatchEvent(new Event('input'))`로 검증했는데, 이 방식은 값 변경 로직(JS 이벤트 리스너)만
    검증할 뿐 실제 마우스 드래그 시 브라우저가 포인터 위치를 값으로 변환하는 네이티브 로직은 전혀
    타지 않는다 — 그래서 "코드상 정상 동작"처럼 보였지만 실제 드래그는 안 되는 상태로 릴리스 직전까지
    남아있었다. 이 환경에서는 `Input.dispatchMouseEvent`(진짜 OS 레벨 입력 합성)도 응답 없이 멈춰서
    자동으로 검증할 수 없었음 — 이런 종류의 "실제 포인터 드래그가 되는지"는 결국 사람이 직접 확인해야
    했다.
- **CDP 자동화 테스트 시 주의**:
  - `Runtime.evaluate`의 `expression`은 페이지의 실제 전역 스코프에서 평가되므로, 서로 다른 `evaluate`
    호출에서 같은 이름으로 `const`/`let`을 반복 선언하면 "Identifier has already been declared" 에러가
    난다 — 매번 `(function(){ ... })()`로 감싸서 로컬 스코프를 만들 것.
  - 렌더러가 `window.api.saveSettings(...)`를 외부에서 직접 호출해 설정 파일에 트랙을 주입해도, 그 후
    `Page.reload`를 하면 `beforeunload` 핸들러가 (여전히 비어 있는) 실제 렌더러 상태로 파일을 덮어써
    버린다 — 이 경로로 테스트하려면 `Page.reload` 대신 프로세스를 완전히 종료/재시작해야 한다.
  - `element.hidden`(IDL 속성)이 올바르게 토글되는지만 확인하는 건 충분하지 않다 — 위의 `[hidden]`
    무력화 버그처럼, 속성은 맞게 바뀌어도 실제 화면에 그려지는 값(`getComputedStyle(el).display`)은
    다를 수 있다. 레이아웃/가시성 버그를 검증할 땐 반드시 computed style을 직접 확인할 것.

### 4.13 가사(Lyrics) 기능 — LRCLIB + 로컬 `.lrc`, 노래방식 하이라이트/자동 스크롤

- **트리거**: 스테이지 우상단 `.stage-toggles` 안, 파형 토글 버튼 옆에 있는 가사 토글 버튼
  (`#btnLyricsToggle`, 가로선 3개 아이콘). 설정 페이지의 "가사 표시" 스위치(`#toggleLyrics`)와
  상태를 공유하며, 둘 다 `setLyricsEnabled()` 하나로 수렴한다. 기본값은 꺼짐(다른 토글들과 달리
  `waveformEnabled`처럼 기본 켜짐이 아님) — 업데이트 후 첫 실행에서 조용히 네트워크 요청이 나가는
  것을 피하기 위함.
- **조회 순서** (`main.js`의 `fetch-lyrics` IPC 핸들러, 렌더러가 아니라 메인 프로세스에서 실행):
  1. 곡 파일과 같은 폴더에 같은 파일명의 `.lrc`가 있으면 그것을 최우선 사용 (오프라인에서도 동작,
     사용자가 직접 편집/교정한 가사를 존중).
  2. `userData/lyricsCache/<sha1(전체경로)>.json` 캐시 — 이전에 조회한 적 있으면 네트워크 요청 없이
     즉시 반환. "찾을 수 없음"도 `{ notFound: true }`로 캐시해서 같은 곡을 열 때마다 매번 재조회하지
     않는다.
  3. [LRCLIB](https://lrclib.net) `/api/get` (파일명에서 `"Artist - Title.ext"` 패턴을 정규식으로 갈라
     `artist_name`/`track_name`/`duration`으로 정확 매칭 시도) → 실패 시 `/api/search`로 퍼지 매칭
     (아티스트/재생시간이 파일명과 안 맞거나 파일명에 아티스트가 없는 경우의 폴백).
  4. 결과를 캐시에 쓰고 렌더러에 `{ source, synced, lrc, plain }` 형태로 반환.
- **왜 메인 프로세스에서 조회하는가**: `index.html`의 CSP가 `default-src 'self'`라 렌더러는 외부
  호스트에 직접 `fetch`할 수 없다. 캐시 파일 읽기/쓰기와 로컬 `.lrc` 탐색도 파일시스템 접근이라
  어차피 메인 프로세스 쪽이 자연스럽다.
- **LRC 파싱** (`renderer.js`의 `parseLRC()`): `[mm:ss.xx]` 형태의 타임태그를 정규식으로 뽑아 초 단위
  타임스탬프로 변환, 한 줄에 태그가 여러 개(한 가사가 여러 타이밍에 반복되는 경우) 붙어 있는 것도
  지원. `[ar:]`/`[ti:]` 같은 메타데이터 줄은 타임태그가 없으므로 자연스럽게 걸러진다.
- **동기화 하이라이트/자동 스크롤**: `mediaEl`의 `timeupdate`마다 `updateActiveLyricsLine()`이
  현재 재생 시각보다 작거나 같은 가장 마지막 줄을 찾아 `.active` 클래스를 옮기고
  `scrollIntoView({ block: 'center', behavior: 'smooth' })`로 가운데 정렬한다 — 매 프레임 다시 그리는
  게 아니라 이미 렌더된 줄 DOM에 클래스만 토글하므로 가볍다.
- **동기화 안 된 가사(plainLyrics만 있는 경우)**: `renderPlainLyrics()`로 하이라이트/스크롤 없는
  고정 텍스트 블록으로만 표시.
- **레이아웃**: `#lyricsView`는 `.video-wrap` 안에서 비디오/커버아트/파형과 같은 자리에 겹치는 별도
  오버레이 레이어(반투명 배경 + `backdrop-filter: blur`)다 — 커버아트-vs-파형 전환 로직과는
  독립적이라, mp4 재생 중에도 영상 위에 가사를 얹어(노래방처럼) 볼 수 있다.
- **트랙 전환 시 재조회**: `loadTrack()`이 `resetLyricsView()`(이전 곡 가사 즉시 비움 +
  `lyricsRequestToken` 증가로 느리게 도착하는 이전 요청 결과 무시) → `ensureLyricsLoaded()`(가사
  패널이 켜져 있을 때만, 그리고 이미 이 트랙 경로로 조회한 적 없을 때만 fetch)를 호출한다. 가사
  패널이 꺼져 있으면 트랙이 바뀌어도 네트워크 요청이 전혀 나가지 않는다.
- **ID3 태그 연동** (§4.14): LRCLIB 조회 시 파일명 파싱(`"아티스트 - 제목"`)보다 실제 ID3
  아티스트/제목을 우선 사용한다. 메타데이터는 비동기라 트랙 로드 시점엔 아직 없을 수 있어서 —
  파일명만으로 먼저 시도하고, 이후 태그가 도착하면 `applyMeta()`가 `ensureLyricsLoaded(true)`로
  한 번 더 조회한다(단 아직 가사를 못 찾았을 때만: `lyricsResolved` 플래그). "가사 없음" 캐시도
  파일명 기반이었으면(`by: 'filename'`) 태그가 생겼을 때 재조회를 허용한다.

### 4.14 ID3 / 메타데이터 읽기 — 실제 제목·아티스트·앨범아트

- **읽기 위치**: 메인 프로세스(`readTrackMetadata`, `music-metadata` 지연 `require`). 샌드박스
  렌더러는 파일시스템 접근이 없다. `read-metadata` IPC가 `{ path, wantPicture }`를 받아
  `{ title, artist, album, year, durationSec, picture }`를 반환.
- **커버 아트**: `nativeImage`로 가장 긴 변을 600px로 축소한 뒤 data URL로 넘긴다(원본을 그대로
  보내면 IPC 페이로드·렌더러 메모리가 커짐). `.cover-art` 안에서 흐린 배경 복사본(`#albumArtBg`,
  `object-fit: cover` + `blur`) 위에 원본 비율 이미지(`#albumArt`, `object-fit: contain`)를
  얹어 정사각형이 아닌 아트도 레터박스 없이 꽉 채운다. 아트가 있으면 `:has()`로 ♪ 노트를 숨김.
  파형 캔버스는 DOM 순서상 이미지들 뒤에 있어 그 위에 그려진다.
- **캐시 전략**: 텍스트 태그(title/artist/album/year)는 `track.meta`로 붙여 설정 파일에 같이
  저장 → 다음 실행 때 재파싱 안 함. 커버 아트는 설정 JSON에 넣으면 너무 커지므로 저장하지 않고
  트랙을 스테이지에 올릴 때마다 다시 읽는다.
- **첫 실행 파싱 폭주 방지**: 라이브러리를 통째로 불러오거나 태그 캐시가 없는 옛 저장본을 열면
  모든 트랙이 동시에 태그를 원한다 → `metaQueue`로 동시 4개까지만 파싱. 한 번 읽으면 캐시되므로
  이 비용은 사실상 첫 실행 1회.
- **표시**: 재생목록은 `.track-text`(제목 위, `아티스트 · 앨범` 아래 2줄), 재생 정보(now-playing)도
  실제 제목/아티스트. 태그가 없으면 파일명으로 폴백(아티스트 줄 없음). 오버레이에도 실제 제목 전달.
- **`loadArtForTrack` vs `loadMetaForTrack`**: 전자는 스테이지에 올릴 1곡용(`wantPicture: true`,
  텍스트 태그도 없으면 같이 채움), 후자는 재생목록 배경 채우기용(`wantPicture: false`, 빠름).
  둘 다 `applyMeta()`로 수렴하고 `artLoadToken`으로 느린 아트 응답이 새 트랙을 덮지 않게 한다.

## 5. 프로세스 간 통신(IPC) 채널 요약

| 채널 | 방향 | 용도 |
|---|---|---|
| `open-files-dialog` | renderer→main (invoke) | 파일 선택 다이얼로그 |
| `toggle-overlay` | renderer→main (invoke) | 오버레이 창 열기/닫기, 열림 여부 반환 |
| `overlay-command` | overlay→main→renderer | 오버레이 버튼 클릭(재생/이전/다음/볼륨/탐색)을 메인 창에 전달 |
| `overlay-close` | overlay→main | 오버레이 닫기 |
| `player-state-update` | renderer→main→overlay | 재생 상태(제목/재생여부/볼륨/진행률/EQ 등) 오버레이에 반영 |
| `player-level-update` | renderer→main→overlay | 오디오 레벨(0~1, 100ms 간격) — 오버레이 dot 박동용, 가벼운 채널 |
| `overlay-closed` | main→renderer | 오버레이가 닫혔음을 메인 창 UI(핀 버튼)에 반영 |
| `remote-command` | main→renderer | 오버레이 또는 트레이 메뉴에서 온 커맨드 실행 |
| `get-app-version` / `check-for-update` / `download-update` / `install-update` | renderer→main (invoke) | 자동 업데이트 |
| `update-status` | main→renderer | 업데이트 진행 상태 이벤트 |
| `load-settings` / `save-settings` | renderer↔main | 설정 파일 읽기/쓰기 |
| `get-intro-video-url` | splash→main (invoke) | 인트로 영상의 `file://` URL 조회 |
| `splash-done` | splash→main | 인트로 영상 종료/건너뛰기 → 스플래시 창 닫고 메인 창 표시 |
| `fetch-lyrics` | renderer→main (invoke) | 로컬 `.lrc` → 캐시 → LRCLIB 순으로 가사 조회 (§4.13) |
| `read-metadata` | renderer→main (invoke) | ID3/MP4/Vorbis 태그 + (선택) 축소된 앨범아트 읽기 (§4.14) |

## 6. 배포 절차 (재현용 명령어)

```bash
# 1. 의존성 설치
npm install

# 2. 개발 실행
npm start

# 3. 빌드 (installer exe 생성, dist/ 폴더)
npm run dist

# 4. 배포 (GitHub Releases 업로드까지, GH_TOKEN 필요)
npm run publish
```

**주의 — 애셋 파일명 함정**: `electron-builder`가 만드는 `dist/latest.yml`은 파일명의 공백을
**대시(-)**로 치환한 이름(`Ullim-Setup-1.0.0.exe`)을 기대한다. 만약 `npm run publish`
(electron-builder 자체 업로더) 대신 `gh release upload`로 **원본 파일명(공백 포함)**을 그대로 올리면,
GitHub이 공백을 **점(.)**으로 치환해버려서 이름이 서로 안 맞아 앱의 자동 업데이트가
`Cannot find asset "Ullim-Setup-x.x.x.exe"` 오류로 실패한다. `gh`로 수동 업로드할 때는 반드시
로컬에서 파일명을 대시 버전으로 복사한 뒤 그 이름으로 올릴 것.

```bash
cp "dist/Ullim Setup 1.0.x.exe" "dist/Ullim-Setup-1.0.x.exe"
cp "dist/Ullim Setup 1.0.x.exe.blockmap" "dist/Ullim-Setup-1.0.x.exe.blockmap"
gh release create vX.X.X --repo <owner>/<repo> --draft \
  "dist/Ullim-Setup-1.0.x.exe" \
  "dist/Ullim-Setup-1.0.x.exe.blockmap" \
  "dist/latest.yml"
# 그 다음 GitHub 웹에서 draft를 "Publish release"로 공개해야 electron-updater가 찾아냄 (draft는 안 보임)
```

**주의 — `signAndEditExecutable: false`와 아이콘**: 이 PC의 Windows 보안 정책 때문에
`package.json`의 `build.win.signAndEditExecutable`을 `false`로 꺼뒀는데(§7 참고), 이 옵션은
**exe에 아이콘을 심는 rcedit 단계까지 같이 꺼버린다**. 그래서 `npm run dist`만 실행하면 `build.win.icon`을
지정해도 실제 exe에는 기본 Electron 아이콘이 박힌다. 아이콘을 실제로 반영하려면 빌드 후 수동으로
rcedit를 한 번 더 돌려야 한다:

```bash
# 1. 평소처럼 빌드 (아이콘은 아직 안 박힌 상태)
npm run dist

# 2. rcedit로 언팩된 exe에 아이콘 수동 삽입
#    rcedit 바이너리는 winCodeSign 캐시 폴더 아무 데나 있음 (부분 다운로드라도 rcedit 자체는 받아짐):
#    C:\Users\<user>\AppData\Local\electron-builder\Cache\winCodeSign\<hash>\rcedit-x64.exe
"<rcedit-x64.exe 경로>" "dist\win-unpacked\Ullim.exe" --set-icon "build\icon.ico"

# 3. 아이콘이 박힌 win-unpacked를 그대로 다시 NSIS로 포장 (재패키징 없이)
npx electron-builder --prepackaged "dist\win-unpacked" --win nsis
```
`--prepackaged`는 electron-builder가 처음부터 다시 패키징하지 않고, 이미 있는 `win-unpacked` 폴더를
그대로 설치파일로 감싸기만 하므로 방금 rcedit로 심은 아이콘이 유지된다. NSIS 설치파일(`Setup.exe`)
자체의 아이콘은 `signAndEditExecutable`과 무관하게 `build.win.icon` 설정만으로 정상 반영된다 —
문제는 오직 앱 내부의 실행 파일(`Ullim.exe`)에만 있다.

## 7. 이 PC에서 겪었던 환경 이슈 (재현 시 참고)

- **Windows 애플리케이션 제어 정책**: 이 PC는 서명되지 않은 새 실행파일 실행을 막는 보안 정책이 걸려
  있어서, `electron-builder`가 언인스톨러를 생성하려고 방금 빌드한 exe를 스스로 실행하는 단계에서
  `spawn UNKNOWN` 오류가 난 적이 있음 (정책이 풀리거나 예외 처리되면 재현 안 될 수 있음).
- **Git Bash에서 `spawn UNKNOWN`**: 일부 자식 프로세스 실행은 PowerShell에서는 되고 Git Bash(POSIX
  sh)에서는 실패하는 경우가 있었음 — 안 될 때 다른 셸로 재시도해볼 것.
- **`.env`/토큰류를 다루는 셸 명령은 자동화 차단기(classifier)에 걸릴 수 있음** — 이런 경우
  `gh` CLI가 이미 로그인되어 있으면 `gh` 명령 자체(토큰을 별도로 읽어 echo/redirect하지 않고 `gh`가
  내부적으로 처리하는 것)는 대체로 통과함. 토큰 값을 직접 다루는 명령(`echo $TOKEN`,
  `$env:GH_TOKEN = ...`)은 막힐 수 있으므로 피할 것.
- **Draft 릴리스 공개(Publish release)는 자동화가 막힘** — 사람이 GitHub 웹에서 직접 눌러야 함.

## 8. 향후 아이디어 (아직 미구현, 논의됨)

현재 진행 순서(사용자 확인, 2026-09-10): **① ID3 태그 읽기(완료, §4.14) → ② 멀티 재생목록 →
③ 실시간 곡 검색 → ④ UI/UX 시인성 → ⑤ 다이나믹 컬러 테마 → ⑥ 오버레이·작업표시줄 모드 전환 →
⑦ 오디오 엔진(IR 리버브 + 크로스페이드)**. 릴리스는 이 묶음이 어느 정도 끝난 뒤 한 번에.

- ~~ID3 태그 읽기~~ — 완료 (§4.14). ID3 태그 **편집기**는 이번 범위에서 빠짐(읽기만).
- ~~멀티 재생목록~~ — 완료 (§4.15).
- ~~실시간 곡 검색~~ — 완료 (§4.16).
- ~~UI/UX 시인성~~ — 완료 (현재 곡 강조/보조 텍스트 대비/폰트·간격, §4.1 참고).
- ~~다이나믹 컬러 테마~~ — 완료 (§4.17).
- **⑥ 오버레이 ↔ 작업표시줄 모드 전환 (다음 작업 대상)**: 플로팅 미니 위젯 vs 작업표시줄 툴바 모드 토글.
- **⑦ 오디오 엔진 고도화**: 지금 컨볼버는 절차적 노이즈 임펄스(`buildImpulseResponse`) — 실제 IR
  샘플(.wav) 리버브로 교체, 트랙 전환 시 스마트 크로스페이드.
- 폴더 통째로 추가 (재귀적으로 오디오 파일 스캔)
- 미디어 키(키보드/이어폰 재생 버튼) 지원 — Electron `globalShortcut` 또는 `MediaSession` API
- Windows 작업표시줄 썸네일 툴바 버튼 (`BrowserWindow.setThumbarButtons`)
- 리버브 wet 게인을 % 옆에 dB로도 보조 표시 (사용자 의견 교환만 하고 미적용 상태)
- `build/icon.ico`는 현재 32×32 한 사이즈만 포함되어 있음 — 외주로 아이콘을 새로 받을 땐
  16/32/48/256px을 전부 포함한 멀티 레졸루션 ico로 요청할 것 (큰 사이즈에서 흐려지는 것 방지)
