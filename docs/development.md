# 개발

저장소를 받아서 고치고 싶을 때.

[← README 로 돌아가기](../README.md)

---

## 개발

```sh
npm test           # node --test test/*.test.js — 334개 테스트, 의존성 0
npm start          # node bin/cici.js
npm run build:ext  # src/ 의 공유 파서를 extension/lib/ 로 복사
npm run check:ext  # 복사본이 원본과 같은지 쓰기 없이 확인
npm run icons      # extension/icons/*.png 재생성
```

빌드 도구는 없다. 확장은 순수 ES 모듈로 그대로 로드된다.

```
src/                     Node ≥18.17, 의존성 0
├─ leveldb-core.js       파서 본체. node: import 이 하나도 없다 — 확장이 이 파일을 그대로 쓴다
├─ snappy.js             .ldb 데이터 블록용 raw snappy 디코더. 역시 공유
├─ leveldb.js            node:fs 어댑터 — readLevelDb(dir)
├─ browsers.js           OS·브라우저별 user-data 위치 → 프로필 목록
├─ claude.js             <profile>/Local Extension Settings/<claude ext id>/
├─ index.js              프로필 하나당 한 행
└─ cli.js                인자 파싱 · 표/JSON 출력

extension/               MV3, 빌드 단계 없음
├─ manifest.json         permissions: storage / host_permissions: file:///*
├─ popup.html/.css/.js   UI. 사람이 읽는 문장은 전부 popup.js 에서 만든다
├─ _locales/{ko,en}/     ko 가 기본
└─ lib/
   ├─ leveldb-core.js  ┐ src/ 의 자동 생성 복사본. 직접 고치지 말 것
   ├─ snappy.js        ┘ build:ext 가 만들고, 테스트가 바이트 단위로 비교한다
   ├─ fileurl.js        file:// 바이트 소스 + Chromium 디렉터리 리스팅 파서
   ├─ locate.js         프로필 열거 + nonce 왕복
   └─ read.js           프로필 → bridgeDeviceId / bridgeDisplayName
```

`extension/lib/leveldb-core.js` 와 `extension/lib/snappy.js` 는 자동 생성물이다.
`src/` 쪽을 고친 뒤 `npm run build:ext` 를 돌린다. 동기화가 깨지면 `npm test` 가 빨개진다.

---
