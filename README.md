# Music Player Pro

로컬 mp3 / mp4 파일을 재생하는 데스크톱 음악 플레이어입니다 (Electron).

## 기능
- mp3, mp4, wav, ogg, m4a, flac, webm 파일 재생 (버튼으로 추가 또는 드래그 앤 드롭)
- 플레이리스트 관리 (추가 / 삭제 / 전체 삭제 / 클릭 재생)
- 이전 곡 / 다음 곡 / 반복재생(끄기·전체·한 곡) / 셔플
- 탐색 바(구간 이동), 볼륨 조절
- 이퀄라이저: Bass / Mid / Treble (±15dB), Reverb(잔향) 0~100%
- 프리셋: Flat, Bass Boost, Vocal, Hall Reverb

## 실행 (개발 모드)
```bash
npm install
npm start
```

## 설치용 exe 빌드
```bash
npm run dist
```
빌드가 끝나면 `dist` 폴더에 설치 파일(.exe, NSIS)이 생성됩니다.
