# MemoryPlace

3D 뉴런 그래프와 줄이 있는 종이 화면을 오가는 메모장입니다. TypeScript, React, Three.js WebGL2, Fastify, MongoDB로 구현했습니다.

## 실행

Node.js 22 이상과 MongoDB가 필요합니다. DB 접속 문자열은 Git에 넣지 말고 저장소 루트의 `.env.local`에 보관합니다.

```sh
cp .env.example .env.local
# .env.local의 MONGO_URL을 실제 앱 전용 DB 계정으로 수정
npm ci
npm run dev
```

브라우저에서 <http://127.0.0.1:5173>을 엽니다. 첫 앱 계정은 `admin / 1234`이며 로그인 직후 비밀번호 변경이 필요합니다. 이 계정은 MongoDB 관리자 계정과 별개입니다.

원격 DB의 포트를 로컬에 직접 노출하지 않는 구성에서는 별도 터미널에서 SSH 터널을 유지합니다.

```sh
ssh -N -L 127.0.0.1:27019:127.0.0.1:27019 <DB_SSH_HOST>
```

운영 환경에서는 `npm run build && npm start`로 정적 웹 파일과 API를 같은 서버에서 제공합니다. 로그인 쿠키가 `Secure`로 설정되므로 외부 서비스 앞에는 HTTPS 역방향 프록시가 필요합니다. 호스트와 도메인 정보는 저장소에 포함하지 않습니다.

## 검증

```sh
npm run build
MONGO_URL='<폐기 가능한 테스트 DB 접속 문자열>' npm test
```

통합 테스트는 별도 DB를 생성하고 종료 시 삭제합니다. 렌더 부하 시험용 데이터는 **테스트 DB에서만** 만들 수 있습니다.

```sh
MONGO_URL='<테스트 DB 접속 문자열>' MONGO_DB_NAME=memoryplace_benchmark npm run bench:seed
```

## 문서

- [제품·기술 설계](docs/architecture.md)
- [MongoDB 배포 안내](infra/mongo/README.md)
- [원격 저장소](https://github.com/kyoungrae/MemoryPlace)

현재 구현: 로그인과 첫 비밀번호 변경, 여러 보드, 3D 노드 이동·크기 조절·연결, 제목 검색, 줄 있는 페이지 편집, 자동 저장·로컬 임시 저장, JSON 내보내기. 노드는 GPU 인스턴스로 묶고, 초기 그래프는 1,500개 단위로 가져오며 멀리서 큰 그래프를 군집으로 표시합니다. 5,000개 노드·약 10,000개 링크의 테스트 데이터를 생성해 API 조회를 확인했지만 실기기 프레임 목표는 아직 검증되지 않았습니다. HTTPS 운영 배포와 백업 자동화도 별도 구성해야 합니다.
