        (() => {
            const cv = document.getElementById('scene');
            const ctx = cv.getContext('2d');
            const sky = document.createElement('canvas');
            const S = sky.getContext('2d');
            const cloudLayer = document.createElement('canvas');
            const CL = cloudLayer.getContext('2d');
            // 구름 블룸: 구름층만 1/4로 줄여 밝은 부분을 뽑고(색 유지 거듭제곱) 두 반경으로 흐려 하늘에 screen 합성.
            // bloomA = 밝은 부분(1/4), bloomB = 곱셈용 사본/가까운 번짐, bloomP = 축소 피라미드(1/8, 1/16, 1/32)
            const bloomA = document.createElement('canvas'), BA = bloomA.getContext('2d');
            const bloomB = document.createElement('canvas'), BB = bloomB.getContext('2d');
            const bloomP = [0, 1, 2].map(() => { const c = document.createElement('canvas'); return { c, g: c.getContext('2d') }; });
            // 뒷층 림라이트용 스크래치: 방사형 빛을 그려 수직 페이드로 자른 뒤 CL에 source-atop 합성.
            // (하부 구름층·수평선에는 닿지 않고 상부·뒷층만 밝힌다)
            const rimL = document.createElement('canvas'), RL = rimL.getContext('2d');
            // horizon-side blur for the reflection only
            const band = document.createElement('canvas');
            const BD = band.getContext('2d');
            const FILTER_OK = (() => { const t = document.createElement('canvas').getContext('2d'); t.filter = 'blur(1px)'; return t.filter === 'blur(1px)'; })();
            const BAND_SCALE = FILTER_OK ? 2 : 5;   // work at reduced resolution; without filter support the downscale itself blurs
            // NOTE: BAND_PAD/BLUR_PX/BAND_H 실값은 CFG에서 관리 (debug UI로 조절). 아래 구형 상수는 삭제됨.
            let bandH = 0;
            // band blur cache: 비싼 blur+복사는 BAND_EVERY 프레임마다만 갱신, 사이엔 blit만
            let bandTick = 0, bandValid = false, bandLastP = -1, bandBuilds = 0;
            // torii sprite and its flipped, darkened copy for the reflection
            const torC = document.createElement('canvas');
            const TC = torC.getContext('2d');
            const torR = document.createElement('canvas');
            const TR = torR.getContext('2d');
            let torS = 1, torX = 0, torY = 0, torW = 0, torH = 0, torBase = 0;
            // torii sprite cache: 색(p)/크기(dpr)가 바뀔 때만 torC/torR 재래스터
            let torKey = '', torRKey = '', torBuilds = 0;
            // sky-mirror downscale buffer (REFL_SCALE < 1일 때만 사용)
            const reflC = document.createElement('canvas');
            const RC = reflC.getContext('2d');
            const RM = window.matchMedia('(prefers-reduced-motion: reduce)');
            // 에셋 기준 URL: 스크립트 위치 기준. public/에서는 문서 기준과 동일하고,
            // wallpaper/vendor/처럼 스크립트가 하위 폴더에 있으면 vendor/ 기준으로 해석된다.
            // (Image/fetch의 상대경로는 문서 기준이라 wallpaper.html에서 'lantern-front.svg'가
            //  404가 되어 본 랜턴이 통째로 사라지고 수평선 경량 띠만 남는다.)
            const ASSET_BASE = (() => {
                try {
                    const cur = (document.currentScript && document.currentScript.src) || '';
                    const found = cur || [...document.scripts].map(s => s.src).find(s => /tsukuyomi\.js(\?|#|$)/.test(s)) || '';
                    if (found) return new URL('.', found).href;
                } catch (e) { /* 폴백: 문서 기준 */ }
                return '';
            })();
            const assetUrl = rel => {
                try { return new URL(rel, ASSET_BASE || document.baseURI).href; }
                catch (e) { return rel; }
            };
            // 절차적 구름 라이브 렌더러(cloud-live.js). 없거나 WebGL2 실패면 null → duskRender가 CPU로 굽는다
            const cloudLive = window.CloudLive ? window.CloudLive.create() : null;
            // real torii and vignette live on their own layer above the ripple copy,
            // so only the mirror image bends
            const fg = document.getElementById('fg');
            const FG = fg.getContext('2d');

            const elPanel = document.getElementById('panel');
            const elStatus = document.getElementById('status');
            const elDay = document.getElementById('btnDay');
            const elDusk = document.getElementById('btnDusk');
            const elNight = document.getElementById('btnNight');
            const elMirror = document.getElementById('btnMirror');

            // ---------- tunable params (F12 debug UI에서 수동 조절) ----------
            // 모든 수치 파라미터는 CFG 하나로 모음. 기본값 = 기존 하드코딩 값과 동일.
            // debug 패널(tsukuyomi.debug.js)이 window.__TSUKUYOMI__ 를 통해 live로 읽고 쓴다.
            const CFG = {
                T_NIGHT: 8.0, T_DAY: 2.4, T_SUNSET: 4.7, TN_GAMMA: 1.5, W_SLOW: 0.025, TRAIL_LEN: 0.6,
                // T_NIGHT: 밤 전환 전체 시간. 해가 진 뒤 밤까지 대기 구간이 길어 9.5 → 8.0 단축.
                // TN_GAMMA: toNight 전반부 가속(ease-out 지수). 낮 출발의 파랑→주황 전반부가 길어
                // 체감 정체가 크므로 전반만 가속하고 후반(궤적·달)은 완만하게. 1.0 = 기존 선형.
                // T_SUNSET: 일몰(nk: 태양 고도/소멸/여광) 전용 전환 시간. 하늘·달·별궤적(T_NIGHT)과 분리.
                // 별 회전은 달 상승(mt)과 동일한 보간으로 동기화되며 별도 고속 단계가 없다.
                // 최종 궤적 길이는 TRAIL_LEN 그대로 유지된다.
                P_DAY: 0, P_DUSK: 0,
                HZ_RATIO: 0.56, DPR_MAX: 2, PIX_BUDGET: 5e6,
                BAND_PAD: 12, BLUR_PX: 3, BAND_H: 0.3, BAND_EVERY: 3,
                POLE_X: 0.25, POLE_Y: 0.27,
                SUN_F: 0.03, SUN_MIN: 14, SUN_MAX: 34,
                MOON_F: 0.026, MOON_MIN: 12, MOON_MAX: 28,
                // MOON_SIZE: 달(미러볼) 크기 배율. moonR 계산 마지막에 곱한다.
                MOON_SIZE: 2,
                TORII_SCALE: 0.7, TORII_X: 0.5, TORII_BASE: 0.75,
                // TORII_X는 토리이 중심과 달 중심이 공유하는 수직선 (항상 같은 x)
                MOON_Y: 0.34,
                STAR_DENS: 2400, STAR_MAX: 1600, STAR_A0: 0.64, STAR_A1: 0.86,
                // 북극성 제거로 미사용 더미(복원 시 buildStars/drawStars도 함께 복원)
                POLARIS_R: 0.7, HALO_R: 4, HALO_A: 0.35,
                MTN_H: 0.022, MTN_MIN: 6, MTN_MAX: 20, MTN_TH: 0.47, MTN_POW: 1.15,
                MTN_W0: 0.62, MTN_W1: 0.28, MTN_W2: 0.10,
                // MTN_SHOW: 1 = 산 표시, 0 = 숨김. 숨김 상태가 기본값이며 생성·착색 코드는 더미로 보존(1로 되돌리면 복원).
                MTN_SHOW: 0,
                // 낮 구름 세트(CLOUD_*): 547f49e 시점 로직 그대로. 황혼 세트(DC_*)와 코드·값을 공유하지 않는다.
                CLOUD_N: 7, CLOUD_SP0: 0.003, CLOUD_SP1: 0.005, CLOUD_Y0: 0.5, CLOUD_YR: 0.34,
                CLOUD_X0: -0.25, CLOUD_SPREAD: 1.4,
                CLOUD_F0: 0.2, CLOUD_F1: 0.48,
                // 황혼 전용 구름 세트(낮 구름과 분리): 수평선 위 하부 띠 + 랜덤 적란운.
                // 낮 ↔ 황혼 세트 전환은 sunVis(낮=1, 황혼=0)로 크로스페이드, DC_F0/F1: 황혼 구름 → 밤 소멸 구간.
                // DC_CB_N: 적란운 최대 개수(실제 개수는 시드 기반 1~N 랜덤), DC_CB_SP: 띠 대비 적란운 흐름 속도 배율. DC_LX/LY: 화면 밖 좌상단 광원 위치.
                DC_SEED: 5, DC_N: 9, DC_Y0: 0.93, DC_YR: 0.07,
                DC_CB_N: 3, DC_CB_S0: 0.95, DC_CB_S1: 1.5, DC_CB_SP: 0.4,
                DC_F0: 0.36, DC_F1: 0.58,
                DC_LX: 0.16, DC_LY: -0.12, DC_LIGHT: 0.34,
                // 황혼 구름 질감(적운 셰이더 랩 파라미터): 덮임 정도, 윗면/아랫면 경계 폭, 덩어리 크기, 그림자 깊이, 빛 방향(°, y-up)
                DC_COV: 0.52, DC_SHARP: 0.105, DC_SOFT: 0.15, DC_SCALE: 8.1, DC_ABSORB: 1.25, DC_SUN: 160,
                // 황혼 명암 대비(reference-images/twilight-ref1.png 기준, 새 낮처럼 혹 단위 음영을 살린다):
                // DC_VLIFT 중간톤 리프트(낮을수록 그늘 깊음), DC_SKYBOT 아랫쪽 직사광 감쇠 바닥, DC_UPK 위쪽 하늘빛 비중,
                // DC_CB_*: 적란운 전용 — 빛 각도(°, y-up, 좌상단), 혹 크기, 거대 형태 흡수(낮을수록 덩어리 안쪽 혹까지 빛이 닿음), 실버 라이닝
                DC_VLIFT: 0.15, DC_SKYBOT: 0.5, DC_UPK: 1.15,
                DC_CB_SUN: 138, DC_CB_SCALE: 7, DC_CB_ABSORB: 0.8, DC_CB_RIMK: 0.6, DC_CB_RS: 0.75,
                // DC_LOBE: 덩어리 안쪽(거대 형태 그늘 속)에서도 남는 혹 단위 명암 비중, DC_CREASE: 혹 사이 골짜기 밝기(낮을수록 주름 깊음)
                DC_LOBE: 0.4, DC_CREASE: 0.5, DC_LOBE_W: 0.75, DC_BAND_LOBE: 0.26,
                // 새 낮 장면(reference-images/day-empty-ref.png 기반): 가운데 구름 틈의 광원 + 양옆 거대 적운 벽 + 수평선 낮은 구름 띠.
                // DAY_SCENE: 1 = 새 낮, 0 = 기존 낮(547f49e 하늘·구름·태양, 더미로 보존). 낮 분기(sunVis) 안에서만 갈린다.
                // DY_LX/LY: 구름 틈 광원 위치(화면/수평선 비율), DY_LIGHT: 광원 세기, DY_F0/F1: 새 낮 구름 → 밤 소멸 구간.
                // DY_BAND_N: 수평선 구름 띠 조각 수, DY_SP: 띠 흐름 속도, DY_SWAY: 큰 구름 벽의 좌우 흔들림(화면 비율).
                // DY_STAR_A: 구름 틈 사이 낮 별 밝기, DY_GLINT_N/A: 수면 반짝임 개수/밝기, DY_WATER: 수면 청색 틴트.
                // DY_VLIFT: 셰이더 중간톤 리프트(낮추면 그늘이 깊어져 혹 단위 대비 강화), DY_SKYBOT: 구름 아랫쪽 직사광 감쇠 바닥(1=없음).
                DAY_SCENE: 1,
                // CLOUD_DOC: 1 = 브러시 구름 문서(디버그 패널 › 구름 › 브러시 구름 편집)가 있으면 황혼/새 낮 구름 대신 그린다, 0 = 항상 절차적 구름.
                CLOUD_DOC: 1,
                // 연속 프레임 재생(1비트 영상): VIDEO 1 = 황혼 슬롯을 정적 문서 대신 비트팩으로 재생.
                // VIDEO_SRC: public/clouds/ 아래 팩, VIDEO_FPS 0 = 팩 지정 fps.
                // VIDEO_TSPEED: 구름 배경 질감(billow) 시간 흐름 배율. 원본=1(uTime=실시간) 기준, 0 = 시간 고정(끓음 없음).
                VIDEO: 1, VIDEO_SRC: 'ba-full.json', VIDEO_FPS: 0, VIDEO_TSPEED: 8,
                // 절차적 구름 라이브(cloud-live.js): CL_LIVE 1 = GPU로 계속 다시 그림(0 = 예전처럼 CPU로 한 번 굽기, 재생성 필요),
                // CL_RATE 변화 속도 배율, CL_BOIL 혹 끓음 세기, CL_WARP 윤곽 일렁임/타원 호 지우기, CL_RAND 경계 랜덤화(덮임 변동·침식),
                // CL_HZ 스프라이트당 갱신 빈도, CL_UP 혹 음영에 섞는 위쪽 빛(0 = 해 방향만 → 세로 붓자국 줄무늬가 다시 생김)
                CL_LIVE: 1, CL_RATE: 1, CL_BOIL: 1, CL_WARP: 1, CL_RAND: 1, CL_HZ: 12, CL_UP: 0.9,
                // 구름 블룸: BLOOM 세기(0 = 끔), BLOOM_POW 밝은 부분 추출 문턱(2/4/8/16, 클수록 가장 밝은 곳만 번진다),
                // BLOOM_R 가까운 번짐 반경(하늘 높이 비율), BLOOM_WIDE 넓은 후광 비중
                BLOOM: 0.7, BLOOM_POW: 4, BLOOM_R: 0.02, BLOOM_WIDE: 0.6,
                DY_SEED: 3, DY_LX: 0.46, DY_LY: 0.22, DY_LIGHT: 1.05,
                // DY_GLOW_R: 틈 빛번짐 크기 배율, DY_GLOW_CORE: 중앙부 밝기 배율(코어만), DY_GLOW_A: 전체 밝기 배율(헤일로+코어)
                DY_GLOW_R: 2, DY_GLOW_CORE: 0.47, DY_GLOW_A: 0.93,
                DY_F0: 0.2, DY_F1: 0.5,
                DY_BAND_N: 7, DY_SP: 0.0035, DY_SWAY: 0.01,
                DY_COV: 0.6, DY_SCALE: 8.0, DY_ABSORB: 1.9,
                DY_VLIFT: 0.15, DY_SKYBOT: 0.7, DY_UPK: 0.45,
                // DY_RIMBOT: 뒷층 림라이트가 0이 되는 높이(수평선 비율). 이 아래 하부 구름층·수평선에는 빛이 닿지 않는다.
                DY_RIMBOT: 0.62,
                DY_STAR_A: 0.6, DY_GLINT_N: 420, DY_GLINT_A: 1, DY_WATER: 0.34,
                // DY_COLUMN: 틈 빛의 수면 기둥 세기(0 = 없음)
                DY_COLUMN: 0,
                // 구름 뚫림(ref: 어두운 앞 구름이 불균일하게 찢겨 그 너머 햇빛 받은 흰 구름이 비친다):
                // DY_HOLE 빛 비침 세기(0 = 없음), DY_HOLE_S 뚫림 크기 배율, DY_HOLE_N 덩어리마다 더하는 무작위 뚫림 수,
                // DY_HOLE_EDGE 경계 들쭉날쭉함(앞 구름 혹이 빛 속으로 튀어나오는 정도), DY_HOLE_RIM 뚫림 둘레 구름이 빛을 받는 정도,
                // DY_HOLE_SKY 하늘까지 뚫리는 깊이(0 = 빛 비침만, 하늘은 안 보임)
                DY_HOLE: 1, DY_HOLE_S: 1, DY_HOLE_N: 1, DY_HOLE_EDGE: 1, DY_HOLE_RIM: 0.35, DY_HOLE_SKY: 0,
                SUN_PATH: 0.42, SUN_X0: 0.27, SUN_X1: 0.32, SUN_DROP: 2.4,
                SUN_F0: 0.34, SUN_F1: 0.46,
                SUN_G0: 0.18, SUN_G1: 0.32, SUN_G2: 0.4, SUN_G3: 0.56,
                MOON_A0: 0.70, MOON_A1: 0.96, MOON_GLOW: 9, MOON_A: 0.24,
                // TRAIL_A0/A1: 별궤적 생성 전용 구간. 달 상승(MOON_A0/A1)과 분리되어 궤적만 0.75배 감속.
                // 구간폭 0.35 = 0.26/0.75 (달 구간폭 0.26을 0.75배율로 환산). 종료점은 달과 동일하게 0.96 유지.
                TRAIL_A0: 0.61, TRAIL_A1: 0.96,
                HAZE_MIX: 0.22, HAZE_A: 0.32,
                REFL_AMP0: 0.15, REFL_AMP1: 2.4, SEAM_A: 0.22,
                SL_F0: 0.11, SL_F1: 1.1, SL_F2: 0.037, SL_F3: 0.7, ROW_STEP: 8,
                REFL_SCALE: 1, REFL_AUTO: 1, REFL_MAX_STEP: 8,
                RIP_MAX: 20, RIP_V: 0.42, RIP_MAX_R: 0.95, RIP_K: 80, RIP_STR: 0.04, FOCAL: 0.9,
                LANTERN_N: 130, LANTERN_GX: 0.54, LANTERN_SN0: 0.02, LANTERN_SN1: 1,
                LANTERN_TX: 1, LANTERN_PAD: 2, LANTERN_DEPTH_K: 2,
                // UI 회피: 1 = 하단 컨트롤 패널 실측 영역을 비움, 0 = 끔(회피 없음)
                LANTERN_CARD_AVOID: 1,
                // 수평선 근접 경량 랜턴: 본 랜턴(3px 이상) 위쪽 띠를 같은 밀도 곡선으로 이어서 채움.
                // FAR_MUL: 곡선 대비 개수 배율, FAR_Y0: 수평선에서 시작하는 거리(px), FAR_MAX: 개수 상한
                LANTERN_FAR_MUL: 1, LANTERN_FAR_Y0: 1.5, LANTERN_FAR_MAX: 4000,
                LANTERN_H: 0.15, LANTERN_GLOW: 0.7, LANTERN_POOL: 0.4,
                // 황혼 글로우: DUSK_GLOW = 황혼(밤 이전) 글로우 강도(밤=1), HALO = 먼 랜턴일수록 후광 반경 확대,
                // FAR_BLOOM = 수평선 경량 랜턴 띠의 번짐(블룸) 강도
                LANTERN_DUSK_GLOW: 0.9, LANTERN_HALO: 1, LANTERN_FAR_BLOOM: 1.85,
                LANTERN_SEED: 10,
            };
            const CFG_DEFAULTS = JSON.parse(JSON.stringify(CFG));
            // 모바일 레이아웃에서는 랜턴 기본값 축소 (PC 130 → 모바일 30). 이하 디버그 미조작 시 기준값.
            const LANTERN_N_PC = 130, LANTERN_N_MOBILE = 30;
            let lastMobile = false;
            try {
                lastMobile = window.matchMedia('(max-width: 460px), (pointer: coarse) and (max-height: 500px)').matches;
            } catch (e) { /* matchMedia 미지원 시 PC 값 유지 */ }
            if (lastMobile) {
                CFG.LANTERN_N = LANTERN_N_MOBILE;
                CFG_DEFAULTS.LANTERN_N = LANTERN_N_MOBILE;
            }
            // 수동 스크럽용 플래그 (debug UI에서 토글)
            let debugHold = false;    // true면 p 자동 진행을 멈추고 슬라이더 값을 그대로 유지
            let debugPaused = false;  // true면 update/stepRipples 전체를 멈춤 (렌더는 계속)

            // ---------- helpers ----------
            const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
            const lerp = (a, b, t) => a + (b - a) * t;
            const ss = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
            const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
            const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
            const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
            const prep = keys => keys.map(k => k.map((v, i) => (i > 0 && typeof v === 'string') ? hex(v) : v));
            function keyed(keys, x) {
                if (x <= keys[0][0]) return keys[0].slice(1);
                for (let i = 1; i < keys.length; i++) {
                    if (x <= keys[i][0]) {
                        const a = keys[i - 1], b = keys[i];
                        const t = ss(a[0], b[0], x);
                        return a.slice(1).map((v, j) => Array.isArray(v) ? mix(v, b[j + 1], t) : lerp(v, b[j + 1], t));
                    }
                }
                return keys[keys.length - 1].slice(1);
            }
            function mulberry32(a) {
                return function () {
                    a |= 0; a = a + 0x6D2B79F5 | 0;
                    let t = Math.imul(a ^ a >>> 15, 1 | a);
                    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
                    return ((t ^ t >>> 14) >>> 0) / 4294967296;
                };
            }

            // ---------- palettes keyed by effective progress q (0 = day idle blue, DUSK_Q = dusk idle orange, 1 = night) ----------
            // 낮/황혼/밤 선택은 하단 아이콘 버튼이 정하고, p(시간값)는 현재 p에서 목표까지 부드럽게 이동한다.
            // P_DAY/P_DUSK는 낮/황혼 idle의 시간값으로 별도 조정되며 기본값은 모두 0이다.
            // p가 0 근처일 때는 타입(duskW)에 따라 낮=푸른 하늘 / 황혼=주황 하늘이 갈리고,
            // 중간 전환부(p >= DUSK_Q)에서는 타입에 관계없이 항상 황혼 corridor를 공유한다.
            // (낮->밤 전환은 파랑을 거쳐 주황 중간대를 지나 밤으로 가고, 황혼->밤은 주황을 유지한 채 밤으로 간다.)
            const DUSK_Q = 0.32;  // 구 P_DUSK 기본값: 황혼 idle의 팔레트 위치 (주황). p≈0에서 황혼 색을 재현한다.
            const P_NOON_DUMMY = 0;  // 낮 idle 시작점 (p = 0, 실제 사용)
            // 5단 그라데이션: [q, top, upper(0.30), mid(0.58), low(0.80), horizon(1.0)]
            // 황혼(0.26/0.34)은 참조 장면의 매직아워: 코발트 → 라벤더 → 핑크 → 수평선 자주.
            // 밝기가 0.80에서 정점을 찍고 수평선에서 다시 내려가므로 3단으로는 표현 불가.
            // 0.42는 공용 corridor라 주황 수평선을 빼서 보라 → 밤으로 바로 이어지게 한다.
            const SKY_STOPS = [0, 0.30, 0.58, 0.80, 1];
            let SKY_RAW = [
                [0.00, '#2a64b4', '#4b83c7', '#6aa0d8', '#a5c6e6', '#dbe9f3'],
                [0.16, '#2f63ad', '#5886c1', '#7ea7d3', '#b6c6d2', '#e8e2d2'],
                [0.26, '#4e5687', '#6f77ab', '#9d95c6', '#cfa3c6', '#b3809a'],
                [0.34, '#4e5687', '#6f77ab', '#9d95c6', '#cfa3c6', '#b3809a'],
                [0.42, '#141a44', '#2c2a62', '#4a3070', '#6a3672', '#7a3c6e'],
                [0.52, '#070b22', '#111536', '#1a1f48', '#333059', '#4a3f68'],
                [0.64, '#03050f', '#05091a', '#070d24', '#101a38', '#18264a'],
                [1.00, '#02040c', '#040816', '#060b20', '#0f1a35', '#172848']
            ];
            // 구형 3단 항목 [q, top, mid, hor] → 5단으로 보간 (debug 스냅샷 호환)
            const skyTo5 = raw => raw.map(e => {
                if (e.length !== 4) return e;
                const [q, t, m, h] = e, T = hex(t), M = hex(m), Z = hex(h);
                const hx = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
                return [q, t, hx(mix(T, M, 0.30 / 0.58)), m, hx(mix(M, Z, 0.22 / 0.42)), h];
            });
            let SKY = prep(SKY_RAW);
            // 낮 분기 전용 하늘(547f49e 시점 3단 팔레트 그대로): 낮 idle과 낮→밤 전환(파랑 → 주황 → 밤)에 쓴다.
            // 위 SKY는 황혼 분기 전용. 두 팔레트는 sunVis(낮=1, 황혼=0)로만 섞이므로 서로 영향을 주지 않는다.
            let SKY_DAY_RAW = skyTo5([
                [0.00, '#2a64b4', '#6aa0d8', '#dbe9f3'],
                [0.16, '#2f63ad', '#7ea7d3', '#e8e2d2'],
                [0.26, '#E87A5D', '#EE966C', '#F3B27A'],
                [0.34, '#E06D53', '#EA9067', '#F3B27A'],
                [0.42, '#121838', '#523866', '#d0604c'],
                [0.52, '#070b22', '#1a1f48', '#4a3f68'],
                [0.64, '#03050f', '#070d24', '#18264a'],
                [1.00, '#02040c', '#060b20', '#172848']
            ]);
            let SKY_DAY = prep(SKY_DAY_RAW);
            // 새 낮(DAY_SCENE=1) 하늘: day-empty-ref의 짙은 코발트 → 수평선 쪽 옅은 청색. 구름 틈의 밝은 청록은 광원(DY_*)이 맡는다.
            // 밤으로 갈 때는 주황 노을 대신 블루 아워(짙은 남색)를 거쳐 공용 밤 팔레트로 이어진다.
            let SKY_DAY2_RAW = [
                [0.00, '#1b4688', '#2a62a2', '#3c76b2', '#3f6d9e', '#6d9cc6'],
                [0.16, '#183f7c', '#265895', '#336aa3', '#375f8e', '#5d88b2'],
                [0.26, '#152c5e', '#1f3a74', '#2a4782', '#334a7c', '#4a5a88'],
                [0.34, '#101f4a', '#18295c', '#1f3268', '#2a3a6a', '#3c4a78'],
                [0.42, '#0b1434', '#121c46', '#182553', '#22305c', '#33416c'],
                [0.52, '#070b22', '#111536', '#1a1f48', '#2a2f58', '#3a4468'],
                [0.64, '#03050f', '#05091a', '#070d24', '#101a38', '#18264a'],
                [1.00, '#02040c', '#040816', '#060b20', '#0f1a35', '#172848']
            ];
            let SKY_DAY2 = prep(SKY_DAY2_RAW);
            let MOUNT_RAW = [
                [0.00, '#93a8bd'], [0.20, '#8d90a8'], [0.32, '#5b4560'],
                [0.42, '#2a2038'], [0.56, '#0b0d1c'], [1.00, '#04060d']
            ];
            let MOUNT = prep(MOUNT_RAW);
            // 새 낮: 수평선이 구름 그늘에 잠겨 산도 짙은 청회색
            let MOUNT_DAY2_RAW = [
                [0.00, '#3d5779'], [0.20, '#33476a'], [0.32, '#27334f'],
                [0.42, '#1b2036'], [0.56, '#0b0d1c'], [1.00, '#04060d']
            ];
            let MOUNT_DAY2 = prep(MOUNT_DAY2_RAW);
            // torii: vermilion / black (gold 3번째 값은 torii-legacy.svg 호환용으로만 유지, 렌더 미사용)
            let TORII_RAW = [
                [0.00, '#D9472B', '#2A2522', '#C9A24A'],
                [0.30, '#c8452c', '#261f1e', '#c99a4a'],
                [0.42, '#7a2a26', '#1a1418', '#7a6038'],
                [0.56, '#3a1a20', '#0d0b12', '#3e3428'],
                [1.00, '#33171d', '#0b0a10', '#3a3126']
            ];
            let TORII = prep(TORII_RAW);
            // 새 낮: 흐린 청색 빛 아래라 주홍이 조금 가라앉는다 (0.30 이후는 TORII와 동일)
            let TORII_DAY2_RAW = [
                [0.00, '#b8432e', '#221e22', '#a88a4c'],
                [0.30, '#c8452c', '#261f1e', '#c99a4a'],
                [0.42, '#7a2a26', '#1a1418', '#7a6038'],
                [0.56, '#3a1a20', '#0d0b12', '#3e3428'],
                [1.00, '#33171d', '#0b0a10', '#3a3126']
            ];
            let TORII_DAY2 = prep(TORII_DAY2_RAW);
            // shapes in the source SVG's 680×450 space; the feet sit on y = 420
            const TORII_RED = new Path2D(
                'M216 110H244L247 410H213Z M436 110H464L467 410H433Z ' +
                'M331 118h18v76h-18Z M168 192h344v20h-344Z ' +
                'M146 86Q340 124 534 86L532 108Q340 146 148 108Z');
            // shapes from reference-images/torii.svg (torii-legacy.svg는 중앙 액자+금테 제거 전 보관본)
            const TORII_BLK = new Path2D(
                'M210 392h40v28h-40Z M430 392h40v28h-40Z ' +
                'M126 64Q340 108 554 64L548 85Q340 126 132 85Z');
            // SVG-space bounding box
            const TB = { x: 124, y: 62, w: 432, h: 360, base: 420 };
            // 낮 구름 틴트 (547f49e 시점 그대로)
            let CLOUD_TINT_RAW = [
                [0.00, '#ffffff', 0], [0.14, '#ffe8c8', 0.10], [0.26, '#ffb07a', 0.42],
                [0.34, '#ff6f6a', 0.52], [0.42, '#5a3d6e', 0.62], [1.00, '#1a1a30', 0.7]
            ];
            let CLOUD_TINT = prep(CLOUD_TINT_RAW);
            // 황혼 구름은 색을 스프라이트에 직접 구우므로 황혼 idle(≤0.34)에서는 틴트 없음, 밤으로만 어두워진다.
            let DCLOUD_TINT_RAW = [
                [0.00, '#ffffff', 0], [0.34, '#ffffff', 0], [0.42, '#4a2f5e', 0.5], [1.00, '#1a1a30', 0.7]
            ];
            let DCLOUD_TINT = prep(DCLOUD_TINT_RAW);
            // 새 낮 구름도 색을 스프라이트에 굽는다. 블루 아워 → 밤으로만 어두워진다.
            let DAY2_TINT_RAW = [
                [0.00, '#ffffff', 0], [0.12, '#ffffff', 0], [0.26, '#2a3a66', 0.32], [0.42, '#141a36', 0.6], [1.00, '#0d1022', 0.72]
            ];
            let DAY2_TINT = prep(DAY2_TINT_RAW);
            // reflection dimming: day and sunset unchanged, stronger only once the sky is night
            let REFL = [[0, 0.06, 0.20], [0.45, 0.14, 0.34], [0.64, 0.42, 0.60], [1, 0.42, 0.60]];
            let VIG = [[0, 0.05], [0.6, 0.32], [1, 0.32]];
            // 새 낮: 수면이 하늘보다 짙고 가장자리가 가라앉는다
            let REFL_DAY2 = [[0, 0.12, 0.3], [0.45, 0.2, 0.4], [0.64, 0.42, 0.60], [1, 0.42, 0.60]];
            let VIG_DAY2 = [[0, 0.3], [0.6, 0.32], [1, 0.32]];

            // ---------- star brightness levels and colours ----------
            // d = star diameter = trail width (css px), al = brightness for both head and trail
            let LV = [
                { d: 0.9, al: 0.50 },
                { d: 1.2, al: 0.70 },
                { d: 1.6, al: 0.88 },
                { d: 2.2, al: 1.00 }
            ];
            let COLS_RAW = ['#e3ebff', '#ffe7cc', '#b9ccff'];
            let COLS = COLS_RAW.map(hex);

            // ---------- state ----------
            let W = 0, H = 0, HZ = 0, dpr = 1, R = 1;
            let pole = { x: 0, y: 0 }, sunR = 20, moonR = 18;
            // (임시) 최초 접속 황혼→밤 인트로 비활성: false = 황혼 idle로 시작. true로 되돌리면 기존 인트로 복원.
            const INTRO_NIGHT = false;
            let state = INTRO_NIGHT ? 'toNight' : 'dusk', p = 0, tState = 0, tNight = 0;
            // 진행 중인 전환의 시작/목표 p (클릭 시 현재 p에서 캡처 → 어디서든 자연스럽게 전환)
            // P_DAY/P_DUSK가 모두 0이어도 낮/황혼을 구분할 수 있게 목표 타입을 별도로 보관한다.
            // INTRO_NIGHT면 최초 접속 시 황혼(p=0, 황혼 타입)에서 밤으로 자동 전환한다.
            let transFrom = 0, transTo = INTRO_NIGHT ? 1 : 0, transTarget = INTRO_NIGHT ? 'night' : 'dusk';
            // duskW: 0 = 낮 타입(푸른 하늘), 1 = 황혼 타입(주황 하늘). p≈0에서만 색을 가른다.
            // p >= DUSK_Q 구간에서는 duskW와 무관하게 항상 같은 황혼 corridor이므로
            // 낮-밤 전환의 중간부는 타입에 관계없이 항상 황혼을 거친다.
            let duskW = 1, duskFrom = 1, duskTo = 1;
            // 유효 팔레트 조회 위치: 낮 분기(p 그대로)와 황혼 분기(max(p, DUSK_Q))를 duskW로 보간.
            // p=0 + 낮 타입 → 0(파랑), p=0 + 황혼 타입 → DUSK_Q(주황), p>=DUSK_Q → 타입 무관 동일값.
            const palQ = () => lerp(p, Math.max(p, DUSK_Q), duskW);
            // 태양 정규화 진행도 nk (0 = idle 고도 → 1 = night).
            // 낮/황혼 idle 모두 nk = 0에서 시작하므로 최대 태양 고도가 동일하고,
            // p와 함께 연속으로만 움직이므로 전환 중 점프가 없다.
            // 태양 위치/소멸/여광이 모두 nk에 묶이며, toNight에서는 T_SUNSET으로 하늘(T_NIGHT)보다 먼저 진다.
            let nk = 0, nkFrom = 0, nkTo = INTRO_NIGHT ? 1 : 0;
            // 태양 원반 가시도: 낮 = 1, 황혼 = 0(원반 없이 좌상단 광원만). toDay/toDusk에서만 보간하고
            // toNight에서는 출발값을 유지한다 (낮→밤은 해가 지고, 황혼→밤은 원반 없이 진행).
            // 인트로 출발이 황혼이므로 초기값은 황혼(0)이다.
            let sunVis = 0, svFrom = 0, svTo = 0;
            const sunK = () => clamp(nk, 0, 1);
            // 낮 분기 안에서 새 낮(DAY_SCENE=1) / 기존 낮(0, 더미) 선택. 가중치는 sunVis에 곱해 쓴다.
            const day2On = () => (CFG.DAY_SCENE >= 0.5 ? 1 : 0);
            const day2W = () => sunVis * day2On();
            // 하늘 색: 낮 분기(SKY_DAY2 또는 기존 SKY_DAY)와 황혼 분기(SKY)를 sunVis로 보간. idle에서는 한쪽만 쓰인다.
            const skyAt = q => {
                const d = keyed(day2On() ? SKY_DAY2 : SKY_DAY, q);
                if (sunVis >= 1) return d;
                const k = keyed(SKY, q);
                return sunVis <= 0 ? k : k.map((c, i) => mix(c, d[i], sunVis));
            };
            let phi = 0, phiTail = null, omega = 0, clock = 0;   // phiTail: 궤적 꼬리 각도 (null = 궤적 없음)
            // 달 상승 보간(mt)과 궤적 길이를 공유하는 헬퍼: drawSky의 달 위치와 동일한 식
            const moonMT = pp => { const m = ss(CFG.MOON_A0, CFG.MOON_A1, pp); return 1 - Math.pow(1 - m, 3); };
            let stars = [], buckets = [];
            let mtn = [], clouds = [], duskClouds = [];
            // 새 낮: 구름(day2Clouds, 스프라이트는 유휴 시간에 하나씩 굽는다), 구름 틈 별, 수면 반짝임
            let day2Clouds = [], day2Stars = [], glints = [];
            let day2Builds = 0, day2Timer = 0;
            // 수면 반짝임 밝기 판정용 하늘 썸네일 (주기적으로만 읽는다)
            const thumb = document.createElement('canvas');
            thumb.width = 96; thumb.height = 48;
            const TH = thumb.getContext('2d', { willReadFrequently: true });
            let thumbData = null, thumbTick = 0;
            // stone lanterns on the flat (lantern-front.svg, all facing the viewer)
            let lanterns = [], lanImg = null, lanReady = false;
            // lantern raster cache: SVG를 1회 비트맵으로 구워 매 프레임 벡터 재래스터 방지
            const lanC = document.createElement('canvas');
            const LC = lanC.getContext('2d');
            let lanCW = 0, lanCH = 0, lanBodyH = 0;
            // reflection adaptive step governor (ROW_STEP=최소, REFL_MAX_STEP=상한)
            let reflStep = 8, reflLastBase = 8, reflEMA = 16, reflCool = 0;

            // ---------- mirrorball moon (미러볼 SVG 생성기 기본값) ----------
            // 생성기 기본값에서 조정: tilt -32, step 9.5, gap 0.14, jit 0.06, off 1, seed 11,
            // tile #dfe4ea, grout #d3e3e9(밝은 줄눈), dark #5a8696(은빛 타일 그늘) — 상부는 media/mirrorball-ref.png 기준, light #eaf7ff, glowC #fff3f1,
            // pole 0.3, poleR 58, veil 0.8, veilR 0.36, haze 0.47, bloom 0.3,
            // teal 0.6(상부 타일을 어두운 청록 그늘 쪽으로 균일하게), tjit 0(타일별 랜덤 편차, 어두운 쪽 기준으로 밝게만), sheen 0.6(은빛 그라디언트),
            // glint 0.1, gcount 6, gturn 0.22, ghold 0.14, gacc 0.08, gspd 2.5, gwhite 0.74.
            // 40초 주기로 균일 자전. 본체는 캐시 캔버스에 굽고(0.6° 이상 돌아야 다시 그림),
            // 줄눈 빛줄기는 하늘에 라이브로 그린다. 발사 트리거는 미러볼 클릭.
            const MB = {
                tilt: -32, step: 9.5, gap: 0.14, jit: 0.06, off: 1, seed: 11,
                tile: '#dfe4ea', grout: '#d3e3e9', dark: '#5a8696', light: '#eaf7ff', glowC: '#fff3f1',
                pole: 0.3, poleR: 58, veil: 0.8, veilR: 0.36, haze: 0.47, bloom: 0.3,
                teal: 0.6, tjit: 0, sheen: 0.6,
                glint: 0.1, gcount: 6, gturn: 0.22, ghold: 0.14, gacc: 0.08, gspd: 2.5, gwhite: 0.74
            };
            const MB_REF = { amb: 0.30, glow: 1.15, pw: 1.4, njit: 1.2, rim: 0.5, side: [0.5, 0.6, 0.64] };
            const MB_PERIOD = 40;
            const MB_DEFAULTS = JSON.parse(JSON.stringify(MB));
            const MB_S = 280, MB_C = 140, MB_R = 124;
            const MB_POLE_LIMIT = 60, MB_SLOW = 0.1, MB_LN10 = Math.LN10;
            const MB_LON_SPAN = 300;   // 줄눈 경로의 총 경도 이동 한계(극周回=수바퀴 맴돎 방지)
            let mbTiles = [], mbRows = [], mbRot = 0, mbT = 0, mbStreaks = [];
            let mbSpin = true;   // false면 자전 정지 (빛줄기 진행은 계속)
            let mbMX = 0, mbMY = 0, mbMR = 0, mbMV = 0;   // 클릭 히트 판정용(화면 px)
            let pmMX = 0, pmMY = 0, pmMR = 0, pmMV = 0;   // 일반 달 위치(미러볼과 동일 중심, 포커스 핀용)
            const mbBody = document.createElement('canvas');
            mbBody.width = MB_S; mbBody.height = MB_S;
            const MBG = mbBody.getContext('2d');
            let mbBodyRot = NaN;
            const mbRad = d => d * Math.PI / 180;
            const mbSys = tilt => { const T = mbRad(tilt); return { ct: Math.cos(T), st: Math.sin(T) }; };
            const mbV = (lat, lon, s) => {
                const la = mbRad(lat), lo = mbRad(lon);
                const x = Math.cos(la) * Math.sin(lo), y = Math.sin(la), z = Math.cos(la) * Math.cos(lo);
                return [x, y * s.ct - z * s.st, y * s.st + z * s.ct];
            };
            const mbPj = (lat, lon, s) => { const q = mbV(lat, lon, s); return [MB_C + MB_R * q[0], MB_C - MB_R * q[1]]; };
            function mbBuildAll() {
                const rnd = mulberry32(MB.seed), rndR = mulberry32((MB.seed ^ 0x85ebca6b) >>> 0), rndB = mulberry32((MB.seed ^ 0x27d4eb2f) >>> 0);
                mbTiles = [];
                const rows = Math.ceil(180 / MB.step);
                for (let i = 0; i < rows; i++) {
                    const lat = -90 + i * MB.step, lat2 = Math.min(90, lat + MB.step), mid = (lat + lat2) / 2;
                    const n = Math.max(4, Math.round(360 * Math.cos(mbRad(mid)) / MB.step));
                    const ws = []; let sum = 0;
                    for (let j = 0; j < n; j++) { const w = 1 + (rnd() * 2 - 1) * MB.jit; ws.push(w); sum += w; }
                    const lonStart = (rnd() * MB.off) * (360 / n);
                    let lon = lonStart;
                    for (let j = 0; j < n; j++) {
                        const tw = ws[j] * 360 / sum;
                        mbTiles.push({
                            lat, lat2, mid, lon0: lon, tw,
                            jLat: (rndR() * 2 - 1) * MB_REF.njit, jLon: (rndR() * 2 - 1) * MB_REF.njit,
                            jB: rndB() * 2 - 1   // 타일별 반사 밝기 편차(상부 청회색 구간에만 적용)
                        });
                        lon += tw;
                    }
                }
                const m = new Map();
                for (const t of mbTiles) {
                    let r = m.get(t.lat);
                    if (!r) { r = { lat: t.lat, lat2: t.lat2, edges: [] }; m.set(t.lat, r); }
                    r.edges.push(((t.lon0 % 360) + 360) % 360);
                }
                mbRows = [...m.values()].sort((a, b) => a.lat - b.lat);
                mbRows.forEach(r => r.edges.sort((a, b) => a - b));
                mbStreaks = []; mbBodyRot = NaN;
            }
            function mbLit(n, mid, jB = 0) {
                const nz = Math.max(0, n[2]);
                const bb = (MB_REF.amb + MB_REF.glow * Math.pow(Math.max(0, -n[1]), MB_REF.pw)) * (0.45 + 0.55 * nz);
                const pr = Math.max(0.001, mbRad(MB.poleR));
                const pu = Math.max(0, 1 - mbRad(mid + 90) / pr);
                const f = pu * pu * (3 - 2 * pu);
                const b = bb + MB.pole * f * 1.2;
                // 상부(b<1)는 은빛 타일: 그늘(dark) → tile. 타일별 편차를 크게 줘 금속 반사처럼 들쭉날쭉하게,
                // 가장자리로 갈수록 프레넬로 밝아진다(레퍼런스 림). 줄눈은 반대로 밝다(레퍼런스의 흰 테두리).
                const DR = hex(MB.dark), TR = hex(MB.tile), LR = hex(MB.light), GR = hex(MB.grout);
                let fr, fg, fb;
                if (b < 1) {
                    const e = 1 - nz, u = Math.min(1, Math.max(0, (Math.max(0, b) + MB_REF.rim * e * e * e) * (1 - MB.teal) + MB.tjit * (jB + 1) * 0.5));
                    fr = DR[0] + (TR[0] - DR[0]) * u; fg = DR[1] + (TR[1] - DR[1]) * u; fb = DR[2] + (TR[2] - DR[2]) * u;
                } else {
                    const u = Math.min(1, b - 1);
                    fr = TR[0] + (LR[0] - TR[0]) * u; fg = TR[1] + (LR[1] - TR[1]) * u; fb = TR[2] + (LR[2] - TR[2]) * u;
                }
                // 타일 옆면(줄눈 쪽 경사면): 상부는 밝은 줄눈색, 빛 비침(b≥1) 쪽은 기존 그늘로 이어진다.
                const sd = MB_REF.side, w = clamp((1.2 - b) / 0.4, 0, 1);
                const side = [0, 1, 2].map(i => { const d = [fr, fg, fb][i] * sd[i]; return d + (GR[i] - d) * w; });
                return { b, f, w, front: [fr, fg, fb], side };
            }
            function mbRenderBody() {
                const g = MBG, s = mbSys(MB.tilt), K = 1 - MB.gap, fk = MB_R / 200;
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.clearRect(0, 0, MB_S, MB_S);
                g.save();
                g.beginPath(); g.arc(MB_C, MB_C, MB_R, 0, Math.PI * 2);
                g.fillStyle = MB.grout; g.fill(); g.clip();
                const tops = [], bots = [], capQ = [];
                for (const t of mbTiles) {
                    const midLon = t.lon0 + t.tw / 2 + mbRot;
                    if (mbV(t.mid, midLon, s)[2] <= 0) continue;
                    const lon0 = t.lon0 + mbRot, lon1 = lon0 + t.tw;
                    const pts = [mbPj(t.lat, lon0, s), mbPj(t.lat, lon1, s), mbPj(t.lat2, lon1, s), mbPj(t.lat2, lon0, s)];
                    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
                    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
                    const fx = pts.map(q => [cx + (q[0] - cx) * K, cy + (q[1] - cy) * K]);
                    const L = mbLit(mbV(t.mid + t.jLat, midLon + t.jLon, s), t.mid, t.jB);
                    g.beginPath();
                    pts.forEach((q, k) => { k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
                    g.closePath(); g.fillStyle = rgba(L.side); g.fill();
                    g.beginPath();
                    fx.forEach((q, k) => { k ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); });
                    g.closePath();
                    const FS = rgba(L.front);
                    if (L.w > 0 && MB.sheen > 0) {
                        // 은빛 질감(sheen): 타일 대각선으로 그늘 → 본색 → 하이라이트.
                        // 일부 타일(tjit에 비례, tjit 0.25 이상이면 절반)만 방향을 뒤집어 반짝임을 흩뜨린다. tjit 0이면 전부 같은 방향.
                        const [p0, p1] = t.jB > 1 - 4 * MB.tjit ? [fx[1], fx[3]] : [fx[0], fx[2]];
                        const lg = g.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
                        const c = L.front, sw = L.w * MB.sheen, hw = 0.5 * sw;
                        lg.addColorStop(0, rgba(c.map(v => v * (1 - 0.3 * sw))));
                        lg.addColorStop(0.5, FS);
                        lg.addColorStop(1, rgba(c.map((v, i) => v + ([244, 251, 255][i] - v) * hw)));
                        g.fillStyle = lg;
                    } else g.fillStyle = FS;
                    g.fill();
                    tops.push([fx[3], fx[2]]); bots.push([fx[0], fx[1]]);
                    if (L.f > 0.15) capQ.push([fx, FS]);
                }
                g.strokeStyle = 'rgba(222,244,248,0.9)'; g.lineWidth = 1.2 * fk;
                g.beginPath();
                for (const [a, b] of tops) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
                g.stroke();
                g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1 * fk;
                g.beginPath();
                for (const [a, b] of bots) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
                g.stroke();
                // 실루엣 림: 가장자리 10%가 밝은 청백으로 번진다 (레퍼런스 r0.9~1.0)
                const rimG = g.createRadialGradient(MB_C, MB_C, MB_R * 0.74, MB_C, MB_C, MB_R);
                rimG.addColorStop(0, 'rgba(226,240,245,0)');
                rimG.addColorStop(0.6, 'rgba(226,240,245,0.3)');
                rimG.addColorStop(0.9, 'rgba(234,246,248,0.8)');
                rimG.addColorStop(1, 'rgba(238,247,249,0.55)');
                g.fillStyle = rimG; g.fillRect(0, 0, MB_S, MB_S);
                if (MB.veil > 0 || MB.haze > 0) {
                    const cy = MB_C + MB_R * (s.st < 0 ? s.ct : 1), rg = MB_R * 2.1;
                    const gr = g.createRadialGradient(MB_C, cy, 0, MB_C, cy, rg);
                    const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
                    const GC = hex(MB.glowC);
                    for (let k = 0; k <= 16; k++) {
                        const t = k / 16;
                        const u = t / Math.max(0.02, MB.veilR);
                        const core = Math.exp(-2.2 * u * u);
                        const skirt = 0.35 * (1 - sm(0, 1, u * 0.55));
                        const tail = MB.haze * (1 - 0.5 * t);
                        const a = Math.min(0.96, Math.max(0, 1 - (1 - MB.veil * core) * (1 - MB.veil * skirt) * (1 - tail)));
                        gr.addColorStop(t, `rgba(${GC[0] | 0},${GC[1] | 0},${GC[2] | 0},${a.toFixed(3)})`);
                    }
                    g.fillStyle = gr; g.fillRect(0, 0, MB_S, MB_S);
                }
                if (MB.bloom > 0 && capQ.length && FILTER_OK) {
                    g.save();
                    g.beginPath(); g.arc(MB_C, MB_C, MB_R, 0, Math.PI * 2); g.clip();
                    g.globalCompositeOperation = 'lighter';
                    g.globalAlpha = MB.bloom * 0.65;
                    g.filter = `blur(${((4 + MB.bloom * 10) * fk).toFixed(1)}px)`;
                    for (const [q, c] of capQ) {
                        g.beginPath();
                        q.forEach((p, k) => { k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); });
                        g.closePath(); g.fillStyle = c; g.fill();
                    }
                    g.restore();
                }
                g.restore();
                mbBodyRot = mbRot;
            }
            // ---- 줄눈 빛줄기: 타일 사이 줄눈을 따라 흐르는 글린트 (생성기와 동일 경로 규칙) ----
            const mbRowOK = i => { const r = mbRows[i]; return !!r && Math.abs(r.lat) <= MB_POLE_LIMIT && Math.abs(r.lat2) <= MB_POLE_LIMIT; };
            function mbTileAt(i, L) {
                const E = mbRows[i].edges, n = E.length, Ln = ((L % 360) + 360) % 360;
                let j = n - 1;
                for (let q = 0; q < n; q++) { if (E[q] <= Ln) j = q; else break; }
                let ta = E[j], tb = E[(j + 1) % n];
                if (tb <= ta) tb += 360;
                if (Ln < ta) { ta -= 360; tb -= 360; }
                const off = L - Ln;
                return { i, a: ta + off, b: tb + off };
            }
            function mbTileCluster(t) {
                const out = [t, mbTileAt(t.i, t.a - 0.01), mbTileAt(t.i, t.b + 0.01)];
                const m = (t.a + t.b) / 2;
                for (const r of [t.i + 1, t.i - 1]) {
                    if (!mbRowOK(r)) continue;
                    const T = mbTileAt(r, m);
                    out.push(T, m < (T.a + T.b) / 2 ? mbTileAt(r, T.a - 0.01) : mbTileAt(r, T.b + 0.01));
                }
                return out;
            }
            function mbBuildPath(st0) {
                const s = mbSys(MB.tilt), nR = mbRows.length, pg = MB.gturn;
                const zv = (la, lo) => mbV(la, lo + mbRot, s)[2];
                let la = st0.la, x = st0.x, st = st0, last = 0;
                const P = [[la, x]];
                let arc = 0;
                const x0 = x;
                if (Math.abs(la) > MB_POLE_LIMIT) return { P, cum: [0], total: 0 };
                for (let it = 0; it < 800; it++) {
                    if (st.mode === 'v') {
                        const row = mbRows[st.i];
                        const nl = st.dv > 0 ? row.lat2 : row.lat;
                        if (Math.abs(nl) > MB_POLE_LIMIT) break;   // 극캡 진입 차단: 하부 극점 맴돎 방지
                        arc += Math.abs(nl - la); la = nl; P.push([la, x]);
                        if (zv(la, x) < -0.2) break;
                        const side = last ? -last : (Math.random() < 0.5 ? -1 : 1);
                        const east = st.dv > 0 ? side === 1 : side === -1;
                        last = side;
                        st = { mode: 'h', k: st.dv > 0 ? st.i + 1 : st.i, dh: east ? 1 : -1 };
                    } else {
                        if (Math.abs(la) > MB_POLE_LIMIT) break;   // 극 위도선 위 주행 금지
                        const k = st.k, up = k < nR ? mbRows[k] : null, dn = k >= 1 ? mbRows[k - 1] : null;
                        let best = 1e9, kind = 0;
                        const scan = (E, kd) => {
                            for (const e of E) {
                                const d = (((e - x) * st.dh) % 360 + 360) % 360;
                                if (d < 1e-6) continue;
                                if (d < best - 1e-6) { best = d; kind = kd; } else if (d < best + 1e-6) kind |= kd;
                            }
                        };
                        if (up) scan(up.edges, 1);
                        if (dn) scan(dn.edges, 2);
                        if (best > 360) break;
                        x += st.dh * best; arc += best * Math.cos(mbRad(la)); P.push([la, x]);
                        if (zv(la, x) < -0.2 || arc > 720 || Math.abs(x - x0) > MB_LON_SPAN) break;   // 극周回 차단
                        if (Math.random() < pg) {
                            const c = [];
                            if ((kind & 1) && mbRowOK(k)) c.push({ side: st.dh > 0 ? -1 : 1, dv: 1, i: k });
                            if ((kind & 2) && mbRowOK(k - 1)) c.push({ side: st.dh > 0 ? 1 : -1, dv: -1, i: k - 1 });
                            const ok = c.filter(q => q.side !== last);
                            if (ok.length) { const q = ok[Math.floor(Math.random() * ok.length)]; last = q.side; st = { mode: 'v', i: q.i, dv: q.dv }; }
                        }
                    }
                }
                const cum = [0];
                for (let j = 1; j < P.length; j++) cum.push(cum[j - 1] + Math.abs(P[j][0] - P[j - 1][0]) + Math.abs(P[j][1] - P[j - 1][1]) * Math.cos(mbRad(P[j][0])));
                return { P, cum, total: cum[cum.length - 1] };
            }
            // ---- 위아래행 줄눈 경로: 자오선(세로 줄눈)을 따라 단조롭게 상승/하강 ----
            // 행 경계마다 다음 행의 가장 가까운 세로 줄눈으로 미세 스냅(수평 조그 최소)하고 계속 직진한다.
            // 좌우 대각선 경로(계단형)와 1:2 비율로 섞어 쓴다.
            function mbBuildPathV(st0) {
                const s = mbSys(MB.tilt);
                const zv = (la, lo) => mbV(la, lo + mbRot, s)[2];
                let la = st0.la, x = st0.x, i = st0.j;
                const dir = st0.dv > 0 ? 1 : -1;
                const P = [[la, x]];
                let arc = 0;
                const x0 = x;
                if (!mbRows[i] || Math.abs(la) > MB_POLE_LIMIT) return { P, cum: [0], total: 0 };
                for (let it = 0; it < 40; it++) {
                    if (!mbRowOK(i)) break;
                    const row = mbRows[i];
                    let bj = 0, found = false;
                    for (const e of row.edges) {
                        let d = ((e - x) % 360 + 360) % 360;
                        if (d > 180) d -= 360;
                        if (!found || Math.abs(d) < Math.abs(bj)) { bj = d; found = true; }
                    }
                    if (!found) break;
                    if (Math.abs(bj) > 1e-6) {
                        x += bj; arc += Math.abs(bj) * Math.cos(mbRad(la)); P.push([la, x]);
                    }
                    const nl = dir > 0 ? row.lat2 : row.lat;
                    if (Math.abs(nl) > MB_POLE_LIMIT) break;
                    arc += Math.abs(nl - la); la = nl; P.push([la, x]);
                    if (zv(la, x) < -0.2 || arc > 720 || Math.abs(x - x0) > MB_LON_SPAN) break;
                    i += dir;
                }
                const cum = [0];
                for (let j = 1; j < P.length; j++) cum.push(cum[j - 1] + Math.abs(P[j][0] - P[j - 1][0]) + Math.abs(P[j][1] - P[j - 1][1]) * Math.cos(mbRad(P[j][0])));
                return { P, cum, total: cum[cum.length - 1] };
            }
            function mbPathAt(pt, sv) {
                const { P, cum } = pt;
                let j = 0;
                while (j < cum.length - 2 && cum[j + 1] < sv) j++;
                const d = cum[j + 1] - cum[j], t = d > 0 ? Math.min(1, Math.max(0, (sv - cum[j]) / d)) : 0;
                return [P[j][0] + (P[j + 1][0] - P[j][0]) * t, P[j][1] + (P[j + 1][1] - P[j][1]) * t];
            }
            function mbFire() {
                if (!mbRows.length || MB.glint <= 0 || RM.matches) return;
                const s = mbSys(MB.tilt), dg = 180 / Math.PI;
                let center = null;
                for (let tries = 0; tries < 30 && !center; tries++) {
                    const X = Math.random() * 2 - 1, Y = Math.random() * 2 - 1, Z2 = 1 - X * X - Y * Y;
                    if (Z2 < 0.25) continue;
                    const Z = Math.sqrt(Z2);
                    const y = Y * s.ct + Z * s.st, z = -Y * s.st + Z * s.ct;
                    const lat = Math.asin(Math.max(-1, Math.min(1, y))) * dg;
                    const i = Math.floor((lat + 90) / MB.step);
                    if (!mbRowOK(i) || !mbRowOK(i + 1) || !mbRowOK(i - 1)) continue;
                    center = mbTileAt(i, Math.atan2(X, z) * dg - mbRot);
                }
                if (!center) return;
                const cl = mbTileCluster(center);
                for (let q = cl.length - 1; q > 0; q--) { const r = Math.floor(Math.random() * (q + 1));[cl[q], cl[r]] = [cl[r], cl[q]]; }
                for (let n = 0; n < MB.gcount; n++) {
                    const T = cl[n % cl.length], row = mbRows[T.i];
                    const top = Math.random() < 0.5, left = Math.random() < 0.5;
                    const la = top ? row.lat2 : row.lat, x = left ? T.a : T.b;
                    const vert = Math.random() < 1 / 3;   // 위아래행: 좌우 대각선의 절반 확률
                    let path;
                    if (vert) {
                        const dir = Math.random() < 0.5 ? 1 : -1;
                        const j = dir > 0 ? (top ? T.i + 1 : T.i) : (top ? T.i : T.i - 1);
                        if (!mbRowOK(j)) continue;
                        path = mbBuildPathV({ la, x, j, dv: dir });
                    } else {
                        const k = top ? T.i + 1 : T.i;
                        const r = Math.random();
                        const st0 = r < 0.34 ? { mode: 'v', i: T.i, dv: top ? -1 : 1, la, x }
                            : { mode: 'h', k, dh: r < 0.67 ? 1 : -1, la, x };
                        path = mbBuildPath(st0);
                    }
                    if (path.total < 1) continue;
                    const red0 = Math.random() < 0.5;   // 초기 색상: 50% 빨강, 나머지 초록
                    mbStreaks.push({
                        path, spd: (300 + Math.random() * 160) * MB.gspd, len: 32 + Math.random() * 30,
                        hold: MB.ghold, acc: MB.gacc, t0: mbT + (n === 0 ? 0 : Math.random() * 0.08),
                        ph: Math.random(), k: 0.85 + Math.random() * 0.25,
                        red0, backG: red0 && Math.random() < 0.5   // 빨강 중 50%만 가속 중간에 초록으로 복귀
                    });
                }
            }
            function mbTravel(st, age) {
                if (age <= 0) return 0;
                const v = st.spd, h = st.hold, a = st.acc;
                if (age < h) return v * MB_SLOW * age;
                let d = v * MB_SLOW * h, t = age - h;
                if (a > 0) {
                    if (t < a) return d + v * MB_SLOW * a / MB_LN10 * (Math.pow(10, t / a) - 1);
                    d += v * (1 - MB_SLOW) * a / MB_LN10; t -= a;
                }
                return d + v * t;
            }
            function mbUpdateStreaks() {
                mbStreaks = mbStreaks.filter(st => mbTravel(st, mbT - st.t0) - st.len < st.path.total);
            }
            function mbHsl(h, sat, l) {
                const a = sat * Math.min(l, 1 - l);
                const f = n => { const kk = (n + h / 30) % 12; return 255 * (l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1))); };
                return [f(0), f(8), f(4)];
            }
            function mbGlintRGB(p, w) {
                const h = 60 * (1 - Math.cos(2 * Math.PI * p));
                const c = mbHsl(h, 1, 0.55);
                return [255 * w + c[0] * (1 - w), 255 * w + c[1] * (1 - w), 255 * w + c[2] * (1 - w)];
            }
            // ds: 경로 샘플 간격(도). 꺾이는 지점(cum)은 간격과 무관하게 항상 포함된다.
            function mbStreakGeom(ds = 1) {
                const s = mbSys(MB.tilt), w = MB.gwhite;
                const gapPx = Math.max(0.6, MB.gap * MB_R * mbRad(MB.step));
                const segs = [];
                const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
                for (const st of mbStreaks) {
                    if (mbT < st.t0) continue;
                    const pt = st.path, sHead = mbTravel(st, mbT - st.t0), sTail = sHead - st.len;
                    const a = Math.max(0, sTail), b = Math.min(pt.total, sHead);
                    if (b - a < 0.05) continue;
                    const sv = [a, b];
                    for (let v = a + ds; v < b; v += ds) sv.push(v);
                    for (const c of pt.cum) if (c > a && c < b) sv.push(c);
                    sv.sort((p, q) => p - q);
                    const env = MB.glint * st.k;
                    const P = sv.map(v => { const [la, lo] = mbPathAt(pt, v); const q = mbV(la, lo + mbRot, s); return [MB_C + MB_R * q[0], MB_C - MB_R * q[1], q[2], (v - sTail) / st.len]; });
                    for (let j = 1; j < P.length; j++) {
                        const u = (P[j][3] + P[j - 1][3]) / 2;
                        const z = (P[j][2] + P[j - 1][2]) / 2;
                        const prof = Math.pow(u, 1.2) * Math.min(1, (1 - u) * 14 + 0.15);
                        const al = env * prof * sm(0.02, 0.3, z);
                        if (al < 0.01) continue;
                        let ph;
                        if (st.red0 !== undefined) {
                            const ageC = mbT - st.t0, midAcc = st.hold + st.acc * 0.5;
                            const redNow = st.red0 && !(st.backG && ageC >= midAcc);
                            ph = (redNow ? 0 : 0.5) + u * 0.08 + Math.max(0, ageC) * 0.03;
                        } else {
                            ph = st.ph + u * 0.55 + mbT * 0.22;
                        }
                        segs.push({ x0: P[j - 1][0], y0: P[j - 1][1], x1: P[j][0], y1: P[j][1], a: al, halo: mbGlintRGB(ph, w * 0.7), core: mbGlintRGB(ph, 1 - (1 - w) * 0.3) });
                    }
                }
                return { segs, gapPx, hw: gapPx * 2.8 + 3, mw: gapPx * 1.1 + 0.6, cw: Math.max(0.7, gapPx * 0.42) };
            }
            const mbPM = (c, a) => { const k = Math.min(1, a); return `rgb(${c[0] * k | 0},${c[1] * k | 0},${c[2] * k | 0})`; };
            // 빛줄기 성능: 달 위에서 1°가 화면 ~1px이라 1° 샘플은 과샘플 → 화면 MB_SEG_PX 간격으로 샘플.
            // halo blur는 선분마다 걸면 draw마다 필터 레이어가 생겨 프레임 전체가 끊긴다 →
            // 오프스크린에 필터 없이 가산으로 모은 뒤 S에 합성할 때 1회만 blur (blur는 선형이라 선분별 blur의 합과 같다).
            const MB_SEG_PX = 3;
            const mbHaloC = document.createElement('canvas'), MBH = mbHaloC.getContext('2d');
            function mbDrawStreaks(mx, my, mr, m) {
                if (!mbStreaks.length || MB.glint <= 0 || m <= 0.01) return;
                const pxDeg = mr * Math.PI / 180;   // 구 중심에서 1°의 화면 px
                const ds = Math.max(1, MB_SEG_PX / pxDeg);
                const G = mbStreakGeom(ds);
                if (!G.segs.length) return;
                const k = mr / MB_R;
                // 둥근 캡 겹침 보정: 길이 s·굵기 w 선분이 한 점을 덮는 개수 ≈ (w+s)/s. 1° 샘플 때 밝기에 맞춘다.
                const s0 = pxDeg, s1 = ds * pxDeg;
                const ovl = lw => ((lw + s0) / s0) / ((lw + s1) / s1);
                const X = x => mx + (x - MB_C) * k, Y = y => my + (y - MB_C) * k;
                const strokeSegs = (g, wd, key, kk) => {
                    const lw = Math.max(0.6, wd * k), f = kk * m * ovl(lw);
                    g.lineWidth = lw;
                    for (const sg of G.segs) {
                        g.strokeStyle = mbPM(sg[key], sg.a * f);
                        g.beginPath(); g.moveTo(X(sg.x0), Y(sg.y0)); g.lineTo(X(sg.x1), Y(sg.y1)); g.stroke();
                    }
                };
                // halo → 오프스크린(달 영역, 기기 px 정렬)
                const pad = Math.max(0.6, G.hw * k) / 2 + 2;
                const ox = Math.floor((mx - mr - pad) * dpr) / dpr, oy = Math.floor((my - mr - pad) * dpr) / dpr;
                const side = Math.ceil((2 * (mr + pad) + 1) * dpr);
                if (mbHaloC.width !== side || mbHaloC.height !== side) { mbHaloC.width = side; mbHaloC.height = side; }
                else { MBH.setTransform(1, 0, 0, 1, 0, 0); MBH.clearRect(0, 0, side, side); }
                MBH.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr);
                MBH.globalCompositeOperation = 'lighter';
                MBH.lineCap = 'round';
                strokeSegs(MBH, G.hw, 'halo', 0.9);
                S.save();
                S.beginPath(); S.arc(mx, my, mr, 0, Math.PI * 2); S.clip();
                S.globalCompositeOperation = 'lighter';
                S.lineCap = 'round';
                if (FILTER_OK) S.filter = `blur(${(G.hw * k * 0.45).toFixed(1)}px)`;
                S.drawImage(mbHaloC, 0, 0, side, side, ox, oy, side / dpr, side / dpr);
                S.filter = 'none';
                strokeSegs(S, G.mw, 'halo', 0.85);
                strokeSegs(S, G.cw, 'core', 1.15);
                S.restore();
            }
            function mbDrawMoon(mx, my, mr, m) {
                mbMX = mx; mbMY = my; mbMR = mr; mbMV = m;
                if (m <= 0.001) return;
                // 기존 외곽 후광은 유지 (밤 하늘·수면 반사에 어우러지도록)
                const mg = S.createRadialGradient(mx, my, mr * 0.8, mx, my, mr * CFG.MOON_GLOW);
                mg.addColorStop(0, `rgba(200,215,255,${CFG.MOON_A * m})`);
                mg.addColorStop(1, 'rgba(200,215,255,0)');
                S.fillStyle = mg;
                S.beginPath(); S.arc(mx, my, mr * CFG.MOON_GLOW, 0, Math.PI * 2); S.fill();
                const d = Math.abs(mbRot - mbBodyRot);
                if (!(d <= 0.6) && !(d >= 359.4)) mbRenderBody();
                S.save();
                S.globalAlpha = m;
                S.drawImage(mbBody, mx - mr, my - mr, mr * 2, mr * 2);
                S.restore();
                mbDrawStreaks(mx, my, mr, m);
            }

            // ---------- 일반 달 / 미러볼 달 전환 ----------
            // moonTarget: UI가 고른 달('plain' = 달 아이콘, 'mirror' = bi-globe2 아이콘).
            // mbMix: 0 = 일반 달, 1 = 미러볼. 미러볼로는 전환 연출(show)로만 넘어가고, 일반 달로는 짧은 크로스페이드로 돌아간다.
            // mbPending: 밤이 아닐 때 미러볼을 고르면 밤 도착(state === 'night') 시점에 연출을 시작한다.
            let moonTarget = 'plain', mbMix = 0, mbPending = false;
            // 일반 달 스프라이트 (mirrorball-change.mp4 앞부분: 크림색 원반 + 옅은 청회색 바다, 청록 후광). 1회 굽기.
            const PM_S = 256, PM_C = 128, PM_R = 120;
            const pmBody = document.createElement('canvas');
            pmBody.width = PM_S; pmBody.height = PM_S;
            (function pmBake() {
                const g = pmBody.getContext('2d'), rng = mulberry32(23);
                const d = g.createRadialGradient(PM_C - PM_R * 0.3, PM_C - PM_R * 0.3, PM_R * 0.1, PM_C, PM_C, PM_R);
                d.addColorStop(0, '#fcfbf3'); d.addColorStop(0.7, '#f2f1e6'); d.addColorStop(1, '#dfe1d4');
                g.fillStyle = d;
                g.beginPath(); g.arc(PM_C, PM_C, PM_R, 0, Math.PI * 2); g.fill();
                g.save(); g.clip();
                // 바다(어두운 얼룩): 우측·하단 쪽에 옅게 몰린 청회색 덩어리
                for (let i = 0; i < 26; i++) {
                    const an = rng() * Math.PI * 2, rd = Math.sqrt(rng()) * PM_R * 0.85;
                    const x = PM_C + Math.cos(an) * rd + PM_R * 0.18, y = PM_C + Math.sin(an) * rd * 0.9 + PM_R * 0.05;
                    const r = PM_R * (0.06 + rng() * 0.2);
                    const rg = g.createRadialGradient(x, y, 0, x, y, r);
                    rg.addColorStop(0, `rgba(150,172,176,${(0.12 + rng() * 0.14).toFixed(3)})`);
                    rg.addColorStop(1, 'rgba(150,172,176,0)');
                    g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
                }
                // 잔 크레이터
                for (let i = 0; i < 40; i++) {
                    const an = rng() * Math.PI * 2, rd = Math.sqrt(rng()) * PM_R * 0.92;
                    const x = PM_C + Math.cos(an) * rd, y = PM_C + Math.sin(an) * rd, r = PM_R * (0.012 + rng() * 0.035);
                    g.fillStyle = 'rgba(140,160,162,0.16)';
                    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
                    g.fillStyle = 'rgba(255,255,250,0.22)';
                    g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.6, 0, Math.PI * 2); g.fill();
                }
                // 가장자리: 살짝 밝은 림
                const rim = g.createRadialGradient(PM_C, PM_C, PM_R * 0.8, PM_C, PM_C, PM_R);
                rim.addColorStop(0, 'rgba(250,252,246,0)'); rim.addColorStop(1, 'rgba(250,252,246,0.35)');
                g.fillStyle = rim; g.fillRect(0, 0, PM_S, PM_S);
                g.restore();
            })();
            function pmDrawMoon(mx, my, mr0, m, glowA) {
                if (m <= 0.001) return;
                // 원반 크기는 미러볼 구(mbBody 안의 MB_R/MB_C)에 맞춘다. 외곽 후광은 미러볼과 같은 mr0 기준.
                const mr = mr0 * MB_R / MB_C;
                if (glowA > 0.001) {
                    const mg = S.createRadialGradient(mx, my, mr0 * 0.8, mx, my, mr0 * CFG.MOON_GLOW);
                    mg.addColorStop(0, `rgba(200,215,255,${CFG.MOON_A * glowA})`);
                    mg.addColorStop(1, 'rgba(200,215,255,0)');
                    S.fillStyle = mg;
                    S.beginPath(); S.arc(mx, my, mr0 * CFG.MOON_GLOW, 0, Math.PI * 2); S.fill();
                    // 가까운 청록 후광 (영상의 짙은 달무리)
                    const ng = S.createRadialGradient(mx, my, mr * 0.95, mx, my, mr * 3.2);
                    ng.addColorStop(0, `rgba(214,244,242,${0.38 * glowA})`);
                    ng.addColorStop(0.35, `rgba(150,215,220,${0.14 * glowA})`);
                    ng.addColorStop(1, 'rgba(120,190,205,0)');
                    S.fillStyle = ng;
                    S.beginPath(); S.arc(mx, my, mr * 3.2, 0, Math.PI * 2); S.fill();
                }
                const k = mr / PM_R;
                S.save();
                S.globalAlpha = m;
                S.drawImage(pmBody, mx - PM_C * k, my - PM_C * k, PM_S * k, PM_S * k);
                S.restore();
            }
            // 달 그리기: 일반 달을 아래에 불투명하게 깔고 미러볼을 mbMix로 덮는다(중간에 하늘이 비치지 않게).
            function drawMoon(mx, my, mr, m) {
                const k = clamp(mbMix, 0, 1);
                const pmM = m * (1 - k);
                if (k < 0.999 && pmM > 0.001) {
                    pmMX = mx; pmMY = my; pmMR = mr; pmMV = pmM;
                    pmDrawMoon(mx, my, mr, m, pmM);
                } else if (k < 0.999) {
                    pmMX = mx; pmMY = my; pmMR = mr; pmMV = 0;
                    pmDrawMoon(mx, my, mr, m, pmM);
                } else pmMV = 0;
                if (k > 0.001) mbDrawMoon(mx, my, mr, m * k); else mbMV = 0;
                // 전환 연출 중 달 섬광: 교체 순간을 하얗게 덮는다
                if (showT >= 0) {
                    const fl = Math.exp(-Math.pow((showT - 0.62) / 0.24, 2)) * showOut * m;
                    if (fl > 0.005) {
                        S.save();
                        S.globalCompositeOperation = 'lighter';
                        const fg2 = S.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 5);
                        fg2.addColorStop(0, `rgba(255,252,246,${(0.75 * fl).toFixed(3)})`);
                        fg2.addColorStop(0.3, `rgba(240,236,255,${(0.28 * fl).toFixed(3)})`);
                        fg2.addColorStop(1, 'rgba(230,230,255,0)');
                        S.fillStyle = fg2;
                        S.beginPath(); S.arc(mx, my, mr * 5, 0, Math.PI * 2); S.fill();
                        S.restore();
                    }
                }
            }

            // ---- 미러볼 전환 연출 (mirrorball-change.mp4): 1회성 스포트라이트 ----
            // 수평선에서 하늘로 여러 줄기가 발사되어 회전·교차하며 하늘을 덮고(그 사이 달 → 미러볼 교체),
            // 이후 하나씩 꺼지며 초록 줄기가 가장 늦게 남는다. 하늘 캔버스에 그려 수면 반사에도 비친다.
            const SHOW_T = 3.6, SHOW_DS = 3;
            // 디버그 미세조정: n = 줄기 수, speed = 회전 속도 배율, dur = 지속시간 배율(줄기 타임라인만; 달 교체 시점은 고정),
            // rot = 회전각 배율(기울기·흔들림·드리프트 전체)
            const SHOW_DEF = { n: 16, speed: 1.7, dur: 0.5, rot: 1.35 };
            const SHOW = { ...SHOW_DEF };
            const SHOW_COLS = ['#ff7cc8', '#b78cff', '#fff1dc', '#8fa2ff', '#ff8f7c', '#7dffb4', '#ffd0ea'];
            const SHOW_TAIL = ['#7dffb4', '#b4ff86', '#ff8f7c'];
            let showT = -1, showOut = 1, showKill = false, showBeams = [];
            const showC = document.createElement('canvas'), SHG = showC.getContext('2d');
            const showC2 = document.createElement('canvas'), SHG2 = showC2.getContext('2d');
            const showSpr = {};
            function showSprite(col) {
                if (showSpr[col]) return showSpr[col];
                const c = document.createElement('canvas'), w = 48, h = 256;
                c.width = w; c.height = h;
                const g = c.getContext('2d'), C = hex(col);
                // 가로 단면: 가운데가 하얗게 밝은 부드러운 띠. 아래(광원)는 좁고 위로 갈수록 넓어지는 원뿔
                const lg = g.createLinearGradient(0, 0, w, 0);
                lg.addColorStop(0, rgba(C, 0)); lg.addColorStop(0.28, rgba(C, 0.5));
                lg.addColorStop(0.5, rgba(mix(C, [255, 255, 255], 0.45), 1));
                lg.addColorStop(0.72, rgba(C, 0.5)); lg.addColorStop(1, rgba(C, 0));
                g.fillStyle = lg;
                g.beginPath(); g.moveTo(w / 2 - 3, h); g.lineTo(w / 2 + 3, h); g.lineTo(w, 0); g.lineTo(0, 0); g.closePath(); g.fill();
                // 길이 방향 감쇠
                g.globalCompositeOperation = 'destination-in';
                const vg = g.createLinearGradient(0, h, 0, 0);
                vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.04, 'rgba(0,0,0,0.9)');
                vg.addColorStop(0.2, 'rgba(0,0,0,1)'); vg.addColorStop(0.65, 'rgba(0,0,0,0.55)');
                vg.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = vg; g.fillRect(0, 0, w, h);
                return (showSpr[col] = c);
            }
            function makeShowBeams() {
                const out = [], n = clamp(Math.round(SHOW.n) || 0, 1, 64), R = Math.random;
                for (let i = 0; i < n; i++) {
                    // 첫 줄기들: 오른쪽에서 먼저 쓸고 들어오는 보라/분홍 (영상 3.8s)
                    const first = i < 3, tail = !first && i >= n - 3;
                    const x = first ? 0.78 + R() * 0.3 : -0.1 + R() * 1.2;
                    const dir = i % 2 ? 1 : -1;
                    out.push({
                        x,
                        t0: first ? i * 0.07 : 0.22 + R() * 0.38,
                        t1: tail ? 2.2 + R() * 0.4 : 1.25 + R() * 0.8,
                        // 각도(수직 기준 rad): 대부분 곧추선 채 좌우로 흔들리며 교차한다(눕지 않게 진폭·드리프트 제한)
                        a0: first ? -0.4 - R() * 0.2 : (R() - 0.5) * 0.9 - (x - 0.5) * 0.35,
                        w: dir * (0.04 + R() * 0.1),
                        amp: 0.2 + R() * 0.3, f: 0.9 + R() * 1.1, ph: R() * 6.283,
                        wf: 0.7 + R() * 0.9, a: 0.4 + R() * 0.35,
                        col: first ? (i === 1 ? '#ff7cc8' : '#b78cff')
                            : tail ? SHOW_TAIL[i % SHOW_TAIL.length] : SHOW_COLS[(R() * SHOW_COLS.length) | 0],
                    });
                }
                return out;
            }
            function startShow() {
                mbPending = false;
                if (RM.matches) return;   // 동작 줄이기: 연출 없이 update의 크로스페이드만
                showT = 0; showOut = 1; showKill = false; showBeams = makeShowBeams();
            }
            function endShow() { if (showT >= 0) showKill = true; }
            function drawShow() {
                if (showT < 0 || !showBeams.length) return;
                const w = Math.max(1, Math.ceil(W / SHOW_DS)), h = Math.max(1, Math.ceil(HZ / SHOW_DS));
                fitCanvas(showC, w, h); fitCanvas(showC2, w, h);
                SHG.setTransform(1, 0, 0, 1, 0, 0);
                SHG.globalCompositeOperation = 'source-over';
                SHG.clearRect(0, 0, w, h);
                SHG.globalCompositeOperation = 'lighter';
                const L = Math.hypot(W, HZ) * 1.05, k = 1 / SHOW_DS;
                const u = showT / Math.max(0.1, SHOW.dur), ts = showT * SHOW.speed;
                let any = false;
                for (const b of showBeams) {
                    const env = ss(b.t0, b.t0 + 0.28, u) * (1 - ss(b.t1, b.t1 + 0.9, u)) * showOut;
                    if (env < 0.01) continue;
                    any = true;
                    const ang = SHOW.rot * (b.a0 + b.w * ts + b.amp * Math.sin(b.f * ts + b.ph));
                    const tw = W * 0.13 * b.wf;
                    SHG.setTransform(k, 0, 0, k, b.x * W * k, HZ * k);
                    SHG.rotate(ang);
                    SHG.globalAlpha = env * b.a;
                    SHG.drawImage(showSprite(b.col), -tw / 2, -L, tw, L);
                }
                SHG.globalAlpha = 1;
                if (!any) return;
                let src = showC;
                if (FILTER_OK) {
                    SHG2.setTransform(1, 0, 0, 1, 0, 0);
                    SHG2.clearRect(0, 0, w, h);
                    SHG2.filter = `blur(${Math.max(1, W * 0.007 / SHOW_DS).toFixed(1)}px)`;
                    SHG2.drawImage(showC, 0, 0);
                    SHG2.filter = 'none';
                    src = showC2;
                }
                S.save();
                S.globalCompositeOperation = 'lighter';
                S.drawImage(src, 0, 0, w, h, 0, 0, w * SHOW_DS, h * SHOW_DS);
                S.restore();
            }
            function updateMoonMode(dt) {
                if (showT >= 0) {
                    showT += dt;
                    if (showKill) showOut *= Math.exp(-dt * 5);
                    if (showT > Math.max(SHOW_T, SHOW_T * SHOW.dur) || showOut < 0.01) { showT = -1; showBeams = []; showKill = false; }
                }
                if (mbPending && state === 'night') startShow();
                const want = moonTarget === 'mirror' && !mbPending ? 1 : 0;
                // 연출 중에는 섬광 시점(0.45~1.05s)에 미러볼로 교체, 그 외에는 0.8초 크로스페이드
                if (want && showT >= 0) mbMix = Math.max(mbMix, ss(0.45, 1.05, showT));
                else mbMix = want > mbMix ? Math.min(want, mbMix + dt / 0.8) : Math.max(want, mbMix - dt / 0.8);
            }

            const starAlpha = () => ss(CFG.STAR_A0, CFG.STAR_A1, palQ());

            // ---------- scene construction ----------
            function buildStars() {
                const rng = mulberry32(7);
                const corners = [[0, 0], [W, 0], [0, HZ], [W, HZ]];
                R = Math.max(...corners.map(([x, y]) => Math.hypot(x - pole.x, y - pole.y)));
                const dens = 1 / (CFG.STAR_DENS * clamp(W / 1400, 0.55, 1));
                const n = Math.min(CFG.STAR_MAX, Math.round(Math.PI * R * R * dens));
                stars = [];
                buckets = Array.from({ length: 12 }, () => []);
                for (let i = 0; i < n; i++) {
                    const rn = Math.sqrt(0.0004 + rng() * 0.9996);
                    const th = rng() * Math.PI * 2;
                    const u = rng();
                    const lvl = u < 0.55 ? 0 : u < 0.83 ? 1 : u < 0.95 ? 2 : 3;
                    const c = rng();
                    const col = c < 0.62 ? 0 : c < 0.86 ? 1 : 2;
                    const s = { rn, th, lvl, col };
                    stars.push(s);
                    buckets[lvl * 3 + col].push(s);
                }
                // 극점 근접 별: 중심이 비어 보이지 않게 밝은 별 몇 개를 작은 반경에 배치
                for (let i = 0; i < 6; i++) {
                    const rn = 0.008 + rng() * 0.032;
                    const th = rng() * Math.PI * 2;
                    const lvl = i < 2 ? 2 + ((rng() * 2) | 0) : 1 + ((rng() * 2) | 0);
                    const col = (rng() * 3) | 0;
                    const s = { rn, th, lvl, col };
                    stars.push(s);
                    buckets[lvl * 3 + col].push(s);
                }
            }

            function buildMountains() {
                // MTN_SHOW=0(숨김)이면 생성 스킵. 아래 생성 코드는 더미로 보존되어 1로 되돌리면 복원된다.
                if (!(CFG.MTN_SHOW >= 0.5)) { mtn = []; return; }
                const rng = mulberry32(21);
                const octave = n => Array.from({ length: n }, () => rng());
                const a1 = octave(9), a2 = octave(31), a3 = octave(97);
                const sample = (arr, x) => {
                    const f = x * (arr.length - 1), i = Math.floor(f);
                    let t = f - i; t = t * t * (3 - 2 * t);
                    return lerp(arr[i], arr[Math.min(i + 1, arr.length - 1)], t);
                };
                mtn = [];
                for (let i = 0; i <= 320; i++) {
                    const x = i / 320;
                    const v = CFG.MTN_W0 * sample(a1, x) + CFG.MTN_W1 * sample(a2, x) + CFG.MTN_W2 * sample(a3, x);
                    mtn.push(Math.pow(Math.max(0, (v - CFG.MTN_TH) / (1 - CFG.MTN_TH)), CFG.MTN_POW));
                }
            }

            // 낮 구름 스프라이트 (547f49e 시점 로직 그대로). 황혼 구름(duskRender)과 코드를 공유하지 않는다.
            // PAD: 퍼프가 캔버스 경계에서 잘리지 않도록 둔 투명 여백(그리기 위치는 그만큼 보정하므로 모양은 동일).
            function makeCloudSprite(rng) {
                const c = document.createElement('canvas');
                const cw = 560, ch = 220, PAD = 90;
                c.width = cw + PAD * 2; c.height = ch + PAD * 2;
                c.w0 = cw; c.h0 = ch; c.pad = PAD;
                const g = c.getContext('2d');
                g.translate(PAD, PAD);
                for (let i = 0; i < 36; i++) {
                    const u = rng();
                    const x = cw * (0.12 + 0.76 * u);
                    const bell = Math.sin(Math.PI * u);
                    const y = ch * (0.66 - 0.38 * bell * (0.5 + 0.5 * rng()));
                    const r = (22 + rng() * 48) * (0.55 + 0.6 * bell);
                    const gr = g.createRadialGradient(x, y, 0, x, y, r);
                    gr.addColorStop(0, 'rgba(255,255,255,0.55)');
                    gr.addColorStop(0.6, 'rgba(255,255,255,0.32)');
                    gr.addColorStop(1, 'rgba(255,255,255,0)');
                    g.fillStyle = gr;
                    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
                }
                g.globalCompositeOperation = 'destination-out';
                const fl = g.createLinearGradient(0, ch * 0.64, 0, ch * 0.8);
                fl.addColorStop(0, 'rgba(0,0,0,0)'); fl.addColorStop(1, 'rgba(0,0,0,1)');
                g.fillStyle = fl; g.fillRect(-PAD, -PAD, c.width, c.height);
                g.globalCompositeOperation = 'source-atop';
                const sh = g.createLinearGradient(0, ch * 0.2, 0, ch * 0.75);
                sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(126,140,166,0.55)');
                g.fillStyle = sh; g.fillRect(-PAD, -PAD, c.width, c.height);
                return c;
            }

            // ---------- 황혼 전용 구름 ----------
            // 질감은 적운 셰이더 랩을 그대로 옮긴 것: 퍼프 타원들의 엔벨로프(큰 형태)에 반전 워리 fBm(빌로우)을 더해
            // 덮임 정도(DC_COV)로 잘라 콜리플라워 실루엣을 만든다. 윗면 경계는 DC_SHARP, 아랫면은 DC_SOFT 폭으로 자른다.
            // 음영: ① 혹 단위 — 빌로우를 광원(DC_SUN) 쪽으로 미분해 혹마다 광원을 향한 면이 밝다
            //       ② 거대 형태 — 엔벨로프 두께를 광원 쪽으로 적분(DC_ABSORB)하고 아래로 갈수록 직사광이 줄어든다.
            // 착색은 높이별 빛/그늘 램프 + 좌상단 광원 쪽 큰 명암 + 꼭대기 후광. 1/2 해상도에서 계산해 확대한다.
            // 색이 구워져 있어 황혼 idle에서는 틴트를 쓰지 않는다.
            function duskPuff(P, x, y, r, a, ex, ey) { P.push([x, y, r, a, ex, ey]); }
            // 정수 격자 해시 (0..1)
            const duskHash = (x, y, s) => {
                let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b1);
                h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
                h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
                return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
            };
            function duskVnoise(x, y, s) {
                const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
                const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
                const a = duskHash(xi, yi, s), b = duskHash(xi + 1, yi, s);
                const c = duskHash(xi, yi + 1, s), d = duskHash(xi + 1, yi + 1, s);
                return a + (b - a) * ux + (c - a + (d - c - b + a) * ux) * uy;
            }
            function duskVfbm(x, y, s) {
                let n = 0, a = 0.5;
                for (let i = 0; i < 3; i++) { n += a * duskVnoise(x, y, s); x *= 2.1; y *= 2.1; a *= 0.5; }
                return n / 0.875;
            }
            // F1 워리 거리: 셀 중심이 밝은 둥근 혹을 만든다
            function duskWorley(x, y, s) {
                const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
                let d = 8;
                for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
                    const ox = 0.5 + 0.38 * Math.sin(0.8 + 6.2831 * duskHash(xi + i, yi + j, s));
                    const oy = 0.5 + 0.38 * Math.sin(0.8 + 6.2831 * duskHash(xi + i, yi + j, s + 7919));
                    const rx = i + ox - fx, ry = j + oy - fy, q = rx * rx + ry * ry;
                    if (q < d) d = q;
                }
                return Math.sqrt(d);
            }
            const duskRamp = (stops, t) => {
                if (t <= stops[0][0]) return stops[0][1];
                for (let i = 1; i < stops.length; i++) {
                    const [t1, c1] = stops[i];
                    if (t <= t1) {
                        const [t0, c0] = stops[i - 1], k = (t - t0) / (t1 - t0);
                        return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
                    }
                }
                return stops[stops.length - 1][1];
            };
            // 스프라이트 px → 셰이더 랩 uv(화면 높이 = 1) 환산: 스프라이트는 화면에서 대략 1.2배로 그려진다
            const DUSK_UV = 660;
            // m: duskMask 캔버스(크기·여백), P: 퍼프 목록,
            // o.lit / o.shade: 콘텐츠 높이(0=상단, 1=하단)별 빛/그늘 색 [[t, [r,g,b]], ...]
            // o.glow: 광원 핫스팟 [x, y, r] (스프라이트 좌표) | null, o.fade: 밑변 소멸 시작 비율,
            // o.ax: 노이즈 가로 압축(가로로 늘여 그리는 띠에서 혹이 둥글게 남도록), o.seed: 노이즈 시드
            // 선택(새 낮 구름용, 없으면 황혼 기본값): o.sun 광원 각도(°, y-up), o.lx/o.ly 핫스팟(콘텐츠 비율),
            // o.cov/o.scale/o.absorb 질감, o.rimC/o.glowC 실버 라이닝·후광 색, o.gd [핫스팟 밝기, 반대편 밝기]
            function duskRender(m, P, o) {
                // o.rs: 계산 해상도(기본 1/2). 크게 확대해 그리는 적란운은 높여 혹 윤곽이 뭉개지지 않게 한다
                const RS = o.rs ?? 0.5;
                const { w0, h0, pad: PAD } = m;
                const W = Math.ceil(m.width * RS), H = Math.ceil(m.height * RS), N = W * H;
                const top = PAD * RS, hh = h0 * RS;
                const hyOf = y => clamp((y - top) / hh, 0, 1);
                const COV = o.cov ?? CFG.DC_COV, SHARP = CFG.DC_SHARP, SOFT = CFG.DC_SOFT;
                const SC = o.scale ?? CFG.DC_SCALE, ABS = o.absorb ?? CFG.DC_ABSORB;
                // o.skyBot: 아랫쪽 직사광 감쇠 바닥(기본 0.55). o.vLift: 중간톤 리프트(기본 0.35). 새 낮은 혹 단위 대비를 위해 완화해 쓴다
                const SKYBOT = o.skyBot ?? 0.55, VLIFT = o.vLift ?? 0.35;
                // o.lobeMin: 거대 형태 그늘 속에서도 남는 혹 단위 음영 비중(기본 0.18), o.crease: 혹 사이 골짜기 밝기(기본 0.72, 낮을수록 주름 깊음)
                const LOBEMIN = o.lobeMin ?? 0.18, CREASE = o.crease ?? 0.72, LOBEW = o.lobeW ?? 1;   // o.lobeW: 혹 명암 경계 폭(낮을수록 또렷)
                const ax = o.ax ?? 1, UV = 1 / (DUSK_UV * RS), UX = UV * ax;
                const seed = o.seed | 0;
                // 1) 엔벨로프: 퍼프 타원 sdE = 1 - |(p - c) / r| 의 최대값 (랩의 탑 덩어리처럼 1.7배)
                const EXT = 2.4, EOUT = 1.7 * (1 - EXT);
                const E = new Float32Array(N).fill(EOUT - 1);
                for (const [x, y, r, a, ex, ey] of P) {
                    const cx = x * RS, cy = y * RS, rx = r * ex * RS, ry = r * ey * RS;
                    const g = 1.7 * clamp(a, 0.8, 1.15);
                    const xa = Math.max(0, (cx - rx * EXT) | 0), xb = Math.min(W - 1, Math.ceil(cx + rx * EXT));
                    const ya = Math.max(0, (cy - ry * EXT) | 0), yb = Math.min(H - 1, Math.ceil(cy + ry * EXT));
                    for (let py = ya; py <= yb; py++) {
                        const dy = (py - cy) / ry, dy2 = dy * dy, o_ = py * W;
                        for (let px = xa; px <= xb; px++) {
                            const dx = (px - cx) / rx, d = Math.sqrt(dx * dx + dy2);
                            if (d >= EXT) continue;
                            const v = g * (1 - d);
                            if (v > E[o_ + px]) E[o_ + px] = v;
                        }
                    }
                }
                // 1-b) 뚫림(새 낮): o.holes 타원 묶음 [x, y, rx, ry](스프라이트 px) → HL = 원뿔(1 - 거리)의 최대값 + 저주파 흔들림.
                // 착색 단계에서 HL에서 빌로우 노이즈를 빼 문턱으로 자르면, 어두운 앞 구름의 혹이 빛 속으로 튀어나오고
                // 떨어진 혹은 빛 위에 뜬 어두운 조각이 된다. 그 안쪽은 햇빛 받은 흰 구름(다른 위상의 빌로우로 혹 명암)으로 칠한다.
                let HL = null;
                if (o.holes && o.holes.length) {
                    HL = new Float32Array(N).fill(-1);
                    const HX = 1.5;   // 원뿔을 타원 바깥까지 이어 둬야 아래 저주파 흔들림이 경계를 안팎으로 밀 수 있다
                    for (const [x, y, hrx, hry] of o.holes) {
                        const cx = x * RS, cy = y * RS, rx = hrx * RS, ry = hry * RS;
                        const xa = Math.max(0, (cx - rx * HX) | 0), xb = Math.min(W - 1, Math.ceil(cx + rx * HX));
                        const ya = Math.max(0, (cy - ry * HX) | 0), yb = Math.min(H - 1, Math.ceil(cy + ry * HX));
                        for (let py = ya; py <= yb; py++) {
                            const dy = (py - cy) / ry, dy2 = dy * dy, o_ = py * W;
                            for (let px = xa; px <= xb; px++) {
                                const dx = (px - cx) / rx, v = 1 - Math.sqrt(dx * dx + dy2);
                                if (v > HL[o_ + px]) HL[o_ + px] = v;
                            }
                        }
                    }
                    // 경계 흔들기: 타원 묶음 윤곽이 그대로 보이지 않게 저주파 fbm으로 구멍 경계를 크게 밀고 당긴다
                    const HF = 1 / (30 * RS);
                    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
                        if (HL[i] <= -0.5) continue;
                        HL[i] += (duskVfbm(x * HF, y * HF, seed + 41) - 0.5) * 1.3;
                    }
                    // 하늘까지 뚫기(o.holeSky > 0): 뚫림 가운데만 엔벨로프를 파서 하늘이 비친다. 기본은 빛 비침만(파지 않음)
                    const HD = o.holeSky ?? 0;
                    if (HD > 0) for (let i = 0; i < N; i++) {
                        const h = HL[i] - 0.45;
                        if (h <= -0.15) continue;
                        const k = ss(-0.15, 0.85, h) * HD;
                        if (E[i] > -0.9) E[i] -= (E[i] + 0.9) * k;
                    }
                }
                const Eat = (x, y) => E[clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)];
                // 라이브: 엔벨로프까지만 CPU, 노이즈·음영·착색은 GPU에서 계속 다시 그린다(타임랩스처럼 혹이 끓고 윤곽이 일렁임)
                if (cloudLive && cloudLive.ok && CFG.CL_LIVE >= 0.5) {
                    const lc = cloudLive.add({ m, E, HL, W, H, RS, top, hh, COV, SHARP, SOFT, SC, ABS, UV, UX, seed, o, sunDeg: o.sun ?? CFG.DC_SUN });
                    if (lc) return lc;
                }
                // 2) 빌로우 노이즈: 5옥타브(형태) + 앞 3옥타브(광원 쪽 미분용). 약한 도메인 워프로 격자 티를 없앤다
                const N5 = new Float32Array(N), N3 = new Float32Array(N);
                const live = 1.7 * (1 - 2.15);   // 이보다 엔벨로프가 낮으면 노이즈가 최대여도 덮임을 못 넘는다
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    const i = y * W + x;
                    if (E[i] < live) continue;
                    let qx = x * UX * SC, qy = y * UV * SC;
                    const wx = 0.35 * duskVfbm(qx * 0.5, qy * 0.5, seed + 11) - 0.17;
                    const wy = 0.35 * duskVfbm(qx * 0.5 + 7.3, qy * 0.5 + 7.3, seed + 11) - 0.17;
                    qx += wx; qy += wy;
                    let n = 0, a = 0.55, s = 0;
                    for (let k = 0; k < 5; k++) {
                        n += a * (1 - duskWorley(qx, qy, seed + k * 131)); s += a;
                        if (k === 2) N3[i] = n / s;
                        qx = qx * 2.07 + 3.1; qy = qy * 2.07 + 1.7; a *= 0.5;
                    }
                    N5[i] = n / s;
                }
                const N3at = (x, y) => {
                    x = clamp(x, 0, W - 2); y = clamp(y, 0, H - 2);
                    const x0 = x | 0, y0 = y | 0, tx = x - x0, ty = y - y0, i = y0 * W + x0;
                    const a = N3[i] + (N3[i + 1] - N3[i]) * tx, b = N3[i + W] + (N3[i + W + 1] - N3[i + W]) * tx;
                    return a + (b - a) * ty;
                };
                // 3) 광원(DC_SUN, 랩 기준 y-up 각도)을 격자 방향으로: 노이즈 공간 1단위 = 1 / (UX, UV) 격자 px
                // 위쪽 하늘빛(CL_UP)을 섞되 o.upK로 장면별 강도를 조절한다(황혼=1, 새 낮은 낮춰 틈의 거의 수평인 빛을 유지)
                const sa = (o.sun ?? CFG.DC_SUN) * Math.PI / 180;
                const UPMIX = CFG.CL_UP * (o.upK ?? 1);
                const LN = Math.hypot(Math.cos(sa), -Math.sin(sa) - UPMIX);
                const Lx = Math.cos(sa) / LN, Ly = (-Math.sin(sa) - UPMIX) / LN;
                const eL = 0.35 / SC * 0.5;            // 혹 크기에 비례한 미분 간격 (uv)
                const dU = 0.02 / UV;                   // 윗면/아랫면 판정 간격 (격자 px)
                const lit = o.lit, shade = o.shade;
                const lax = (PAD + w0 * (o.lx ?? 0.1)) * RS, lay = top + hh * (o.ly ?? 0), ldiag = Math.hypot(w0, h0) * RS;
                const glow = o.glow ? [o.glow[0] * RS, o.glow[1] * RS, o.glow[2] * RS] : null;
                const [GD0, GD1] = o.gd ?? [1.2, 0.62];
                const RC_ = o.rimC ?? [255, 217, 178], GC_ = o.glowC ?? [255, 250, 236];
                const img = new ImageData(W, H), D = img.data;
                const HOLE = HL ? (o.hole ?? 0) : 0, HEDGE = o.holeEdge ?? 1;
                const HC = o.holeC ?? [246, 250, 255], HC2 = o.holeC2 ?? [150, 170, 210];
                for (let y = 1; y < H - 1; y++) {
                    const hy = hyOf(y);
                    const L0 = duskRamp(lit, hy), S0 = duskRamp(shade, hy);
                    const sky = lerp(SKYBOT, 1, 1 - ss(0.35, 1, hy));   // 아래로 갈수록 직사광이 줄어든다
                    for (let x = 1; x < W - 1; x++) {
                        const i = y * W + x;
                        if (E[i] < live) continue;
                        // 형태: 위로 향한 면은 날카롭게, 아래로 향한 면은 부드럽게 자른다
                        const raw = E[i] * 0.55 + (N5[i] - 0.5) * 1.25 + 0.5;
                        const up = Eat(x, y - dU) - E[i];
                        const edge = lerp(SHARP, SOFT, ss(-0.02, 0.06, up));
                        // 경계 폭이 1px보다 좁으면 계단이 지므로 밀도 기울기만큼은 넓혀 둔다(fwidth 대용)
                        const gx = (E[i + 1] - E[i - 1]) * 0.55 + (N5[i + 1] - N5[i - 1]) * 1.25;
                        const gy = (E[i + W] - E[i - W]) * 0.55 + (N5[i + W] - N5[i - W]) * 1.25;
                        const aa = Math.hypot(gx, gy) * 0.6;
                        const d = ss(COV - aa * 0.5, COV + Math.max(edge, aa), raw);
                        // 뚫림 빛 비침 마스크(GPU와 같은 식): 원뿔 - 빌로우 → 앞 구름 혹이 빛 속으로 튀어나온 경계
                        let rv = 0, hr = -1;
                        if (HOLE > 0) {
                            hr = HL[i] * 1.1 - (N5[i] - 0.5) * 1.5 * HEDGE;
                            rv = ss(0.06, 0.16, hr) * Math.min(1, HOLE) * ss(-0.6, -0.1, E[i]);
                        }
                        if (d <= 0.003 && rv <= 0.003) continue;
                        // ① 혹 단위 음영
                        const n0 = N5[i];
                        let dn = 0;
                        for (let k = 1; k <= 3; k++) dn += (n0 - N3at(x + Lx * eL * k / UX, y + Ly * eL * k / UV)) / k;
                        let lobe = ss(-0.24 * LOBEW, 0.28 * LOBEW, dn);
                        // 주름 그늘: 혹 사이 골짜기(노이즈가 깎인 곳)는 방향과 무관하게 어둡게 — GPU(cloud-live)와 동일식
                        lobe *= lerp(CREASE, 1, ss(0.28, 0.72, n0));
                        // ② 거대 형태 음영
                        let od = 0;
                        for (let k = 1; k <= 4; k++) od += Math.max(Eat(x + Lx * 0.035 * k / UX, y + Ly * 0.035 * k / UV), 0);
                        const macro = Math.exp(-od * ABS * 0.6) * sky;
                        const T = lobe * lerp(LOBEMIN, 1, macro) + 0.15 * macro;
                        const powder = 1 - Math.exp(-d * 4);
                        let v = clamp(lerp(T, T * powder, 0.4), 0, 1);
                        // 덩어리 전체의 빛 분포: 광원 쪽(좌상단) 모서리는 타오르고 반대편은 그늘로 가라앉는다
                        const gd = Math.hypot(x - lax, (y - lay) * 1.25) / ldiag;
                        v *= lerp(GD0, GD1, ss(0.05, 0.95, gd));
                        v = ss(0.1, 0.9, v);
                        v = v + (Math.sqrt(v) - v) * VLIFT;   // 밝은 면은 빛에 씻겨 평평하게 (새 낮은 VLIFT를 낮춰 그늘 유지)
                        let r = S0[0] + (L0[0] - S0[0]) * v;
                        let g = S0[1] + (L0[1] - S0[1]) * v;
                        let b = S0[2] + (L0[2] - S0[2]) * v;
                        // 실버 라이닝: 얇은 가장자리 + 빛 정면 (o.rimK로 새 낮만 강화, 황혼은 기존 0.45 유지)
                        const rimK = o.rimK ?? 0.45;
                        const rim = (1 - ss(0, 0.55, d)) * T * (1 - 0.6 * hy) * rimK;
                        r += (RC_[0] - r) * rim; g += (RC_[1] - g) * rim; b += (RC_[2] - b) * rim;
                        if (glow) {
                            const ddx = x - glow[0], ddy = y - glow[1];
                            const w = Math.exp(-(ddx * ddx + ddy * ddy) / (glow[2] * glow[2])) * (0.35 + 0.65 * v);
                            r += (GC_[0] - r) * w * 0.85; g += (GC_[1] - g) * w * 0.8; b += (GC_[2] - b) * w * 0.7;
                        }
                        if (HOLE > 0) {
                            // 빛 쪽으로 튀어나온 어두운 혹의 가장자리: 얇게 밝아진다
                            const fr = ss(-0.1, 0.06, hr) * (1 - rv) * 0.35;
                            r += (RC_[0] - r) * fr; g += (RC_[1] - g) * fr; b += (RC_[2] - b) * fr;
                            if (rv > 0.003) {
                                const N5at = (u, v) => N5[clamp(Math.round(v), 0, H - 1) * W + clamp(Math.round(u), 0, W - 1)];
                                const qx = x * 0.75 + 41, qy = y * 0.75 + 23;
                                const n2 = N5at(qx, qy), n2b = N5at(qx + Lx * 5, qy + Ly * 5);
                                const lb = clamp((0.3 + 0.7 * ss(-0.1, 0.16, n2 - n2b)) * lerp(0.7, 1, ss(0.3, 0.75, n2)) + ss(0.1, 0.9, HL[i]) * 0.3, 0, 1);
                                r = lerp(r, lerp(HC2[0], HC[0], lb), rv); g = lerp(g, lerp(HC2[1], HC[1], lb), rv); b = lerp(b, lerp(HC2[2], HC[2], lb), rv);
                            }
                        }
                        let A = Math.max(d, rv);
                        if (o.fade < 1) A *= 1 - ss(o.fade, 1, hy);
                        A *= ss(0, 6, Math.min(x, y, W - 1 - x, H - 1 - y));   // 비트맵 가장자리에서 잘린 직선이 보이지 않게
                        const j = i * 4;
                        D[j] = r; D[j + 1] = g; D[j + 2] = b; D[j + 3] = A * 255;
                    }
                }
                const lo = document.createElement('canvas');
                lo.width = W; lo.height = H;
                lo.getContext('2d').putImageData(img, 0, 0);
                const c = document.createElement('canvas');
                c.width = m.width; c.height = m.height;
                c.w0 = w0; c.h0 = h0; c.pad = PAD;
                const g = c.getContext('2d');
                g.imageSmoothingQuality = 'high';
                g.drawImage(lo, 0, 0, c.width, c.height);
                return c;
            }
            function duskMask(w0, h0, PAD) {
                const m = document.createElement('canvas');
                m.width = w0 + PAD * 2; m.height = h0 + PAD * 2;
                m.w0 = w0; m.h0 = h0; m.pad = PAD;
                return m;
            }
            // 큰 뭉게 덩어리 하나 + 윗둘레의 중간 덩어리들: 엔벨로프(큰 형태)만 잡고 잔 혹은 duskRender의 빌로우 노이즈가 만든다
            function duskBillow(P, lr, x, y, R, ex, ey, nSub) {
                duskPuff(P, x, y, R, 0.9 + lr() * 0.2, ex, ey);
                for (let k = 0; k < nSub; k++) {
                    const an = -Math.PI * (0.06 + 0.88 * (k + 0.2 + lr() * 0.6) / nSub);
                    const d = 0.55 + lr() * 0.25, r = R * (0.32 + lr() * 0.2);
                    duskPuff(P, x + Math.cos(an) * R * ex * d, y + Math.sin(an) * R * ey * d, r,
                        0.85 + lr() * 0.25, 0.9 + lr() * 0.3, 0.85 + lr() * 0.25);
                }
            }
            // 하부 띠: 납작한 층운 데크 위에 낮은 뭉게 봉우리가 불규칙하게 솟는다.
            function makeDuskBandSprite(rng) {
                const w0 = 640, h0 = 230, PAD = 200;
                const m = duskMask(w0, h0, PAD);
                const lr = mulberry32((rng() * 4294967296) >>> 0);   // 배치 rng는 한 번만 소비
                const P = [];
                // 봉우리 프로파일: 2~4개의 가우스 봉우리 (높이 = 콘텐츠 상단으로부터의 비율)
                const humps = Array.from({ length: 2 + ((lr() * 3) | 0) }, () => ({
                    u: 0.1 + lr() * 0.8, w: 0.06 + lr() * 0.1, h: 0.3 + lr() * 0.6
                }));
                const top = u => {
                    let v = 0.12;
                    for (const hp of humps) v = Math.max(v, hp.h * Math.exp(-((u - hp.u) ** 2) / (2 * hp.w * hp.w)));
                    return 0.62 - 0.6 * Math.min(1, v);   // 0.02(가장 높은 봉우리) ~ 0.55(데크 윗면)
                };
                // 데크: 가로로 길게 눌린 층
                for (let i = 0; i < 16; i++) {
                    const x = PAD + w0 * (0.03 + 0.94 * (i + lr()) / 16);
                    const y = PAD + h0 * (0.7 + lr() * 0.14);
                    duskPuff(P, x, y, 34 + lr() * 18, 0.85 + lr() * 0.25, 1.8 + lr() * 0.8, 0.5 + lr() * 0.15);
                }
                // 봉우리: 윗면을 따라 큰 덩어리를 늘어놓고 아래로 데크까지 채운다
                for (let i = 0; i < 18; i++) {
                    const u = 0.04 + 0.92 * (i + lr()) / 18;
                    const tp = top(u);
                    const R = 22 + (0.62 - tp) * 70 + lr() * 10;
                    const x = PAD + w0 * u, y = PAD + h0 * tp + R * 0.75;
                    duskBillow(P, lr, x, y, R, 1.15 + lr() * 0.4, 0.8 + lr() * 0.2, 2 + ((lr() * 3) | 0));
                    if (tp < 0.4) duskBillow(P, lr, x + (lr() - 0.5) * R, lerp(y, PAD + h0 * 0.72, 0.6), R * 1.1, 1.3, 0.8, 1);
                }
                return duskRender(m, P, {
                    lit: [[0, [255, 236, 206]], [0.3, [252, 184, 150]], [0.6, [226, 144, 128]], [1, [150, 94, 102]]],
                    shade: [[0, [192, 116, 120]], [0.4, [158, 92, 104]], [0.7, [116, 72, 92]], [1, [84, 54, 78]]],
                    glow: null, fade: 0.9, ax: 1.6, seed: (lr() * 1e6) | 0,
                    vLift: CFG.DC_VLIFT, skyBot: CFG.DC_SKYBOT, upK: CFG.DC_UPK,
                    // 띠는 가로로 늘여 그려 혹 음영이 세로 줄무늬로 늘어지기 쉬우므로 혹 비중·주름을 적란운보다 약하게 둔다
                    lobeMin: CFG.DC_BAND_LOBE, crease: lerp(CFG.DC_CREASE, 1, 0.35), lobeW: 1
                });
            }
            // 황혼 적란운: 넓은 밑동 위로 큰 뭉게 덩어리가 쌓여 솟는다. 꼭대기는 광원에 크림빛, 밑동은 자주빛 그늘.
            function makeDuskCbSprite(rng) {
                const w0 = 600, h0 = 560, PAD = 190;
                const m = duskMask(w0, h0, PAD);
                const lr = mulberry32((rng() * 4294967296) >>> 0);
                const P = [];
                const lean = (lr() - 0.5) * 0.12;   // 탑이 살짝 기울어 개체마다 실루엣이 다르게
                // 밑동: 넓고 납작한 덩어리
                for (let i = 0; i < 7; i++) {
                    const x = PAD + w0 * (0.08 + 0.84 * (i + lr()) / 7);
                    duskBillow(P, lr, x, PAD + h0 * (0.8 + lr() * 0.08), 60 + lr() * 25, 1.4 + lr() * 0.3, 0.6, 2);
                }
                // 탑: 아래에서 위로 큰 덩어리를 쌓는다. 위로 갈수록 좁고 조금 작게
                // 층마다 좌우 두 덩어리: 한쪽으로 쏠린 버섯 모양 대신 넓게 부푼 탑이 되게
                const NT = 5;
                for (let i = 0; i < NT; i++) {
                    const t = (i + 0.2 + lr() * 0.5) / NT;    // 0 = 하단, 1 = 꼭대기
                    const hw = lerp(0.38, 0.22, t);
                    const cx = 0.5 + lean * t + (lr() - 0.5) * 0.08;
                    const y = PAD + h0 * (0.72 - 0.58 * t);
                    for (const side of [-1, 0, 1]) {
                        const x = PAD + w0 * (cx + side * hw * (0.5 + lr() * 0.35));
                        const R = lerp(80, 62, t) * (side ? 0.8 + lr() * 0.35 : 1.05) + lr() * 14;
                        duskBillow(P, lr, x, y + (lr() - 0.5) * 40 + (side ? 14 : -10), R,
                            1 + lr() * 0.2, 0.85 + lr() * 0.15, 2 + ((lr() * 4) | 0));
                    }
                }
                // 꼭대기 왕관
                duskBillow(P, lr, PAD + w0 * (0.5 + lean + (lr() - 0.5) * 0.08), PAD + h0 * 0.17, 78, 1.1, 0.8, 6);
                return duskRender(m, P, {
                    // ref: 혹마다 좌상단 윗면은 크림빛, 혹 사이 골·아랫면은 장밋빛~자주 그늘로 깊게 가라앉는다
                    lit: [[0, [255, 248, 222]], [0.2, [255, 234, 190]], [0.42, [255, 208, 162]], [0.64, [250, 178, 144]],
                          [0.84, [214, 134, 124]], [1, [160, 98, 104]]],
                    shade: [[0, [214, 136, 136]], [0.3, [188, 112, 120]], [0.55, [156, 90, 108]], [0.78, [114, 70, 94]],
                            [1, [84, 56, 82]]],
                    glow: [PAD + w0 * (0.36 + lean), PAD + h0 * 0.12, w0 * 0.24], fade: 0.92, ax: 1, seed: (lr() * 1e6) | 0,
                    sun: CFG.DC_CB_SUN, lx: 0.12, ly: 0, gd: [1.35, 0.6],
                    scale: CFG.DC_CB_SCALE, absorb: CFG.DC_CB_ABSORB, rimK: CFG.DC_CB_RIMK, rs: CFG.DC_CB_RS,
                    vLift: CFG.DC_VLIFT, skyBot: CFG.DC_SKYBOT, upK: CFG.DC_UPK,
                    lobeMin: CFG.DC_LOBE, crease: CFG.DC_CREASE, lobeW: CFG.DC_LOBE_W
                });
            }
            function buildDuskClouds() {
                const rng = mulberry32(Math.round((CFG.DC_SEED ?? 5) * 1000 + 77));
                duskClouds = [];
                // 적란운 먼저(뒤), 띠를 위에 그려 적란운 밑동을 띠가 덮게 한다
                const cbMax = Math.max(0, Math.round(CFG.DC_CB_N ?? 3));
                const ncb = cbMax > 0 ? 1 + ((rng() * cbMax) | 0) : 0;
                const s0 = Math.min(CFG.DC_CB_S0, CFG.DC_CB_S1), s1 = Math.max(CFG.DC_CB_S0, CFG.DC_CB_S1);
                // 첫 적란운은 화면 오른쪽, 나머지는 왼쪽 화면 밖에 줄지어 두어 차례로 흘러 들어온다.
                // 멀리 있는 큰 구름이라 띠보다 느리게(DC_CB_SP 배) 흐른다. 실제 x는 W가 정해진 뒤 placeDuskCb가 확정
                for (let i = 0; i < ncb; i++) {
                    const spr = makeDuskCbSprite(rng), u = rng();
                    duskClouds.push({
                        kind: 'cb', spr, slot: i,
                        xc: 0.72 + u * 0.06,       // slot 0: 콘텐츠 중심의 화면 비율
                        gap: 0.08 + u * 0.25,      // slot 1+: 앞 적란운과의 간격(화면 비율)
                        xn: 0,
                        yn: CFG.DC_Y0 - 0.06 + rng() * 0.06,
                        sp: (CFG.CLOUD_SP0 + rng() * CFG.CLOUD_SP1) * (CFG.DC_CB_SP ?? 0.4),
                        s: s0 + rng() * (s1 - s0)
                    });
                }
                const n = Math.max(0, Math.round(CFG.DC_N));
                for (let i = 0; i < n; i++) {
                    duskClouds.push({
                        kind: 'band',
                        spr: makeDuskBandSprite(rng),
                        xn: -0.35 + (i / Math.max(1, n)) * 1.5 + rng() * 0.06,
                        yn: CFG.DC_Y0 + rng() * CFG.DC_YR,
                        sp: CFG.CLOUD_SP0 + rng() * CFG.CLOUD_SP1,
                        s: 0.85 + rng() * 0.35,
                        sw: 1.3 + rng() * 0.6,
                        sh: 0.8 + rng() * 0.45
                    });
                }
                placeDuskCb();
            }
            // 적란운 초기 x 확정(1회): slot 0은 중심을 xc에 두되 오른쪽으로 넘치지 않게(좁은 화면은 중앙 쪽으로),
            // slot 1+는 앞 적란운의 왼쪽 화면 밖에 gap을 두고 이어 붙인다.
            function placeDuskCb() {
                if (!W) return;
                const base = clamp(W / 1400, 0.5, 1.1);
                let left = 0;
                for (const c of duskClouds) {
                    if (c.kind !== 'cb' || c.slot == null) continue;
                    const cw = c.spr.w0 * base * c.s / W;
                    if (c.slot === 0) c.xn = clamp(c.xc, 0.5, Math.max(0.5, 1 - cw / 2)) - cw / 2;
                    else { left -= cw + c.gap; c.xn = left; }
                    c.slot = null;
                }
            }

            // ---------- 새 낮 전용 구름 (reference-images/day-empty-ref.png) ----------
            // 양옆 거대 적운 벽 + 가운데 아래 밝은 덩어리 + 수평선 낮은 띠. 질감·음영은 황혼 셰이더(duskRender)를 그대로 쓰되
            // 광원이 가운데 구름 틈에 있으므로 덩어리마다 광원 각도(o.sun)와 핫스팟(o.lx/o.ly)을 틈 쪽으로 돌린다.
            // 색: 틈을 향한 윗면만 흰빛, 나머지는 청회색 그늘로 가라앉는다. 색이 구워져 있어 낮 idle에서는 틴트 없음.
            // ref 대비: 혹의 로컬 방향(틈 빛을 받는 윗면)이 흰색을 결정하도록 lit 램프를 높이와 무관하게 평탄하게 두고,
            // 높이/위치 감쇠는 셰이더의 macro·sky·gd가 담당한다. 그늘은 ref의 짙은 네이비(#1F3152 계열)에 맞춘다.
            const DY_LIT = [[0, [252, 253, 255]], [0.3, [246, 250, 255]], [0.55, [238, 244, 254]], [0.8, [208, 221, 243]], [1, [152, 171, 207]]];
            const DY_SHADE = [[0, [96, 114, 164]], [0.3, [64, 82, 132]], [0.6, [40, 54, 98]], [1, [24, 34, 68]]];
            // 2층 분리: 뒷층(림 라이트층)은 틈 빛을 받아 밝고 가장자리가 탐. 앞층(음영층)은 아래에 깔리되 지나치게 꺼멓지 않게.
            const DY_LIT_BACK = DY_LIT;
            const DY_SHADE_BACK = [[0, [112, 130, 178]], [0.3, [78, 96, 146]], [0.6, [52, 68, 116]], [1, [34, 46, 84]]];
            const DY_LIT_FRONT = [[0, [244, 248, 255]], [0.3, [230, 237, 251]], [0.55, [204, 217, 240]], [0.8, [164, 181, 215]], [1, [112, 132, 176]]];
            const DY_SHADE_FRONT = [[0, [94, 110, 152]], [0.3, [70, 86, 128]], [0.6, [48, 62, 104]], [1, [30, 40, 74]]];
            // spec.prof: 윗면 프로파일 [[u, top], ...] (u = 가로 비율, top = 콘텐츠 상단으로부터의 높이 비율)
            function makeDay2MassSprite(lr, spec) {
                const { w0, h0 } = spec, PAD = 180;
                const m = duskMask(w0, h0, PAD);
                const P = [];
                const prof = spec.prof;
                const topAt = u => {
                    if (u <= prof[0][0]) return prof[0][1];
                    for (let i = 1; i < prof.length; i++) {
                        if (u <= prof[i][0]) return lerp(prof[i - 1][1], prof[i][1], ss(prof[i - 1][0], prof[i][0], u));
                    }
                    return prof[prof.length - 1][1];
                };
                const NC = spec.cols, colW = w0 / NC, bot = PAD + h0 * (spec.bot ?? 0.84);
                for (let i = 0; i < NC; i++) {
                    const u = (i + 0.15 + lr() * 0.7) / NC;
                    const tp = topAt(u) + (lr() - 0.5) * 0.03;
                    const R0 = clamp(colW * (0.7 + lr() * 0.35), 26, 110);
                    const x = PAD + w0 * u;
                    let y = PAD + h0 * tp + R0 * 0.8;
                    // 윗면 덩어리: 윗둘레 잔 덩어리가 많아 콜리플라워 실루엣
                    duskBillow(P, lr, x, y, R0, 1 + lr() * 0.25, 0.85 + lr() * 0.15, 3 + ((lr() * 3) | 0));
                    // 아래로 밑변까지 점점 큰 덩어리로 채운다
                    let R = R0;
                    while (y < bot) {
                        R = Math.min(R * 1.12, 120);
                        y += R * (0.8 + lr() * 0.3);
                        duskBillow(P, lr, x + (lr() - 0.5) * colW * 0.6, Math.min(y, bot), R,
                            1.1 + lr() * 0.3, 0.8 + lr() * 0.15, 1 + ((lr() * 2) | 0));
                    }
                }
                // 위성 조각: 윗둘레 바깥에 떨어진 작은 혹 — ref처럼 실루엣이 찢어지고 혹 사이로 하늘이 비친다
                const NS = 3 + ((lr() * 4) | 0);
                for (let i = 0; i < NS; i++) {
                    const u = 0.06 + lr() * 0.88;
                    const tp = topAt(u);
                    const R = 18 + lr() * 30;
                    const x = PAD + w0 * u + (lr() - 0.5) * w0 * 0.06;
                    const y = Math.max(PAD * 0.45, PAD + h0 * tp - R * (1.0 + lr() * 0.9));
                    duskBillow(P, lr, x, y, R, 1 + lr() * 0.35, 0.75 + lr() * 0.2, 1 + ((lr() * 2) | 0));
                }
                const holes = CFG.DY_HOLE > 0 ? day2Holes(lr, spec, PAD, topAt) : null;
                const gl = spec.glow;
                const isFront = spec.layer === 'front';
                return duskRender(m, P, {
                    holes, hole: CFG.DY_HOLE * (isFront ? 0.75 : 1), holeSky: CFG.DY_HOLE_SKY, holeEdge: CFG.DY_HOLE_EDGE,
                    holeRim: CFG.DY_HOLE_RIM * (isFront ? 0.7 : 1),
                    // 비치는 구름 색: 빛 정면(흰빛) ↔ 혹 그늘(옅은 청회색)
                    holeC: isFront ? [228, 236, 250] : [246, 250, 255], holeC2: isFront ? [128, 146, 186] : [150, 170, 210],
                    lit: spec.lit ?? (isFront ? DY_LIT_FRONT : DY_LIT_BACK),
                    shade: spec.shade ?? (isFront ? DY_SHADE_FRONT : DY_SHADE_BACK),
                    glow: gl ? [PAD + w0 * gl[0], PAD + h0 * gl[1], w0 * gl[2]] : null,
                    fade: spec.fade ?? 0.9, ax: 1, seed: (lr() * 1e6) | 0,
                    sun: spec.sun, lx: spec.lx, ly: spec.ly, gd: spec.gd ?? (isFront ? [1.25, 0.5] : [1.4, 0.42]),
                    cov: spec.cov ?? (isFront ? Math.min(0.8, CFG.DY_COV + 0.02) : CFG.DY_COV),
                    scale: CFG.DY_SCALE, absorb: spec.absorb ?? (isFront ? CFG.DY_ABSORB + 0.1 : CFG.DY_ABSORB - 0.25),
                    skyBot: CFG.DY_SKYBOT, vLift: CFG.DY_VLIFT, upK: CFG.DY_UPK,
                    rimC: spec.rimC ?? (isFront ? [222, 232, 248] : [240, 247, 255]),
                    glowC: [250, 252, 255], rimK: spec.rimK ?? (isFront ? 0.5 : 0.85)
                });
            }
            // 구멍 묶음: spec.holes [[u, v, s], ...] (u 가로 비율, v 콘텐츠 상단으로부터의 높이 비율, s 크기 = h0 비율)
            // + DY_HOLE_N개 무작위 구멍. 구멍 하나는 가로로 긴 주 타원 + 둘레로 삐져나간 작은 타원 3~6개라 윤곽이 들쭉날쭉하고,
            // 윗둘레 가까운 것은 바깥 하늘과 이어져 깊게 파인 골이 된다. 반환: [x, y, rx, ry] (스프라이트 px)
            function day2Holes(lr, spec, PAD, topAt) {
                const { w0, h0 } = spec, out = [];
                const list = (spec.holes || []).map(h => h.slice());
                const nr = Math.max(0, Math.round(spec.nHole ?? CFG.DY_HOLE_N));
                for (let i = 0; i < nr; i++) {
                    const u = 0.1 + lr() * 0.8;
                    list.push([u, topAt(u) + 0.05 + lr() * 0.22, 0.035 + lr() * 0.035]);
                }
                const SZ = CFG.DY_HOLE_S;
                for (const [u, v, s0] of list) {
                    const R = s0 * h0 * SZ;
                    // 틈은 둥근 구멍이 아니라 비스듬히 갈라진 골: 가운데서 양쪽으로 걸어가며 크기가 들쭉날쭉한 타원을 잇는다
                    const dir = (lr() - 0.5) * 1.2;
                    const cx = PAD + w0 * u, cy = PAD + h0 * v;
                    out.push([cx, cy, R * (1.0 + lr() * 0.4), R * (0.7 + lr() * 0.3)]);
                    for (const sg of [-1, 1]) {
                        let x = cx, y = cy, a = dir + (sg < 0 ? Math.PI : 0), r = R;
                        const steps = 2 + ((lr() * 3) | 0);
                        for (let k = 0; k < steps; k++) {
                            a += (lr() - 0.5) * 1.1;
                            r *= 0.62 + lr() * 0.4;
                            x += Math.cos(a) * R * (0.55 + lr() * 0.35);
                            y += Math.sin(a) * R * (0.3 + lr() * 0.25);
                            out.push([x, y, r * (1.0 + lr() * 0.5), r * (0.6 + lr() * 0.35)]);
                        }
                    }
                }
                return out;
            }
            // 수평선 낮은 띠: 납작하고 어두운 청회색 덩어리들이 섬처럼 이어진다
            function makeDay2BandSprite(lr) {
                const w0 = 560, h0 = 120, PAD = 140;
                const m = duskMask(w0, h0, PAD);
                const P = [];
                const humps = Array.from({ length: 1 + ((lr() * 3) | 0) }, () => ({
                    u: 0.15 + lr() * 0.7, w: 0.05 + lr() * 0.08, h: 0.3 + lr() * 0.5
                }));
                const top = u => {
                    let v = 0.1;
                    for (const hp of humps) v = Math.max(v, hp.h * Math.exp(-((u - hp.u) ** 2) / (2 * hp.w * hp.w)));
                    return 0.7 - 0.6 * Math.min(1, v);
                };
                for (let i = 0; i < 12; i++) {
                    const x = PAD + w0 * (0.04 + 0.92 * (i + lr()) / 12);
                    duskPuff(P, x, PAD + h0 * (0.72 + lr() * 0.12), 24 + lr() * 12, 0.85 + lr() * 0.25, 1.8 + lr() * 0.8, 0.5 + lr() * 0.15);
                }
                for (let i = 0; i < 10; i++) {
                    const u = 0.06 + 0.88 * (i + lr()) / 10;
                    const tp = top(u);
                    const R = 14 + (0.7 - tp) * 60 + lr() * 6;
                    duskBillow(P, lr, PAD + w0 * u, PAD + h0 * tp + R * 0.75, R, 1.2 + lr() * 0.4, 0.75 + lr() * 0.2, 2 + ((lr() * 2) | 0));
                }
                return duskRender(m, P, {
                    lit: [[0, [122, 144, 184]], [0.5, [84, 104, 148]], [1, [56, 74, 114]]],
                    shade: [[0, [60, 78, 120]], [0.5, [44, 60, 100]], [1, [30, 44, 80]]],
                    glow: null, fade: 0.85, ax: 1.6, seed: (lr() * 1e6) | 0,
                    sun: 90, lx: 0.5, gd: [1.1, 0.8],
                    cov: CFG.DY_COV, scale: CFG.DY_SCALE, absorb: CFG.DY_ABSORB, rimC: [204, 222, 246],
                    skyBot: CFG.DY_SKYBOT, vLift: CFG.DY_VLIFT, upK: CFG.DY_UPK
                });
            }
            // 큰 덩어리 배치: ax = 기준 x(화면 비율), al = 기준이 콘텐츠의 어디인지(0 왼쪽 끝, 0.5 중심, 1 오른쪽 끝),
            // ay = 콘텐츠 밑변(수평선 비율), hh = 콘텐츠 높이(수평선 비율), wmax = 화면에 보이는 최대 너비(화면 비율).
            // 좁은 화면에서 wmax를 넘는 만큼은 바깥쪽 화면 밖으로 밀어 가운데 틈을 남긴다.
            const DAY2_MASS = [
                {   // 왼쪽 뒷벽(림층): 왼쪽 위로 화면 밖까지 솟고 틈 쪽으로 계단처럼 내려온다. 틈 빛을 받아 가장자리가 탐
                    layer: 'back', w0: 860, h0: 700, cols: 13,
                    prof: [[0, 0], [0.18, 0.02], [0.32, 0.12], [0.46, 0.05], [0.6, 0.03], [0.72, 0.18], [0.84, 0.34], [0.94, 0.48], [1, 0.6]],
                    sun: 28, lx: 0.85, ly: 0.15, ax: -0.08, al: 0, ay: 1.0, hh: 1.38, wmax: 0.5, bot: 0.97, fade: 0.95,
                    gd: [1.5, 0.42], absorb: 1.45, rimK: 0.85, swayK: 0.6,
                    holes: [[0.34, 0.15, 0.15], [0.66, 0.3, 0.08], [0.13, 0.38, 0.06]]
                },
                {   // 오른쪽 뒷벽(림층): 왼쪽보다 살짝 낮고 좁아 틈이 왼쪽으로 치우쳐 보인다
                    layer: 'back', w0: 860, h0: 700, cols: 13,
                    prof: [[0, 0.58], [0.08, 0.42], [0.18, 0.26], [0.3, 0.32], [0.42, 0.16], [0.58, 0.06], [0.78, 0.01], [1, 0]],
                    sun: 152, lx: 0.15, ly: 0.15, ax: 1.06, al: 1, ay: 1.0, hh: 1.28, wmax: 0.44, bot: 0.97, fade: 0.95,
                    gd: [1.12, 0.42], absorb: 1.65, rimK: 0.82, swayK: 0.6,
                    holes: [[0.64, 0.12, 0.14], [0.3, 0.3, 0.08], [0.88, 0.36, 0.06]]
                },
                {   // 가운데 틈 속 먼 덩어리(뒷층): 틈을 막지 않게 낮게 깔린다. 꼭대기만 빛을 받아 희게
                    layer: 'back', w0: 460, h0: 300, cols: 7,
                    prof: [[0, 0.55], [0.25, 0.34], [0.5, 0.24], [0.75, 0.34], [1, 0.55]],
                    sun: 90, lx: 0.5, ly: 0, ax: 0.46, al: 0.5, ay: 1.0, hh: 0.5, wmax: 0.3,
                    bot: 0.92, fade: 0.93, gd: [1.25, 0.55], glow: [0.45, 0.1, 0.34], rimK: 0.8, swayK: 0.6
                },
                {   // 왼쪽 앞턱(음영층): 빨간 윤곽 기준 — 바깥은 평평한 데크, 틈 바로 왼쪽에 솟은 타워, 틈 경계는 절벽처럼 떨어진다
                    layer: 'front', w0: 760, h0: 460, cols: 14,
                    prof: [[0, 0.42], [0.35, 0.4], [0.55, 0.38], [0.68, 0.36], [0.76, 0.08], [0.86, 0.06], [0.92, 0.42], [1, 0.62]],
                    sun: 35, lx: 0.8, ly: 0.3, ax: -0.04, al: 0, ay: 1.0, hh: 1.02, wmax: 0.48, bot: 0.98, fade: 0.94,
                    gd: [1.05, 0.5], rimK: 0.5, swayK: 1.4,
                    holes: [[0.8, 0.2, 0.07]], nHole: 0
                },
                {   // 오른쪽 앞턱(음영층): 빨간 윤곽 기준 — 바깥 돔은 높게, 중간에 안장 딥, 틈 쪽으로 경사지게 내려온다
                    layer: 'front', w0: 760, h0: 460, cols: 14,
                    prof: [[0, 0.58], [0.18, 0.45], [0.35, 0.38], [0.52, 0.34], [0.65, 0.42], [0.78, 0.18], [0.9, 0.05], [1, 0.02]],
                    sun: 145, lx: 0.2, ly: 0.3, ax: 1.04, al: 1, ay: 1.0, hh: 0.9, wmax: 0.46, bot: 0.98, fade: 0.94,
                    gd: [1.02, 0.5], rimK: 0.48, swayK: 1.4,
                    holes: [[0.84, 0.24, 0.07]], nHole: 0
                },
            ];
            function buildDay2Clouds() {
                const rng = mulberry32(Math.round((CFG.DY_SEED ?? 3) * 1000 + 313));
                day2Clouds = [];
                for (const spec of DAY2_MASS) {
                    day2Clouds.push({ kind: 'mass', spec, spr: null, seed: (rng() * 4294967296) >>> 0, ph: rng() * Math.PI * 2 });
                }
                const n = Math.max(0, Math.round(CFG.DY_BAND_N));
                for (let i = 0; i < n; i++) {
                    day2Clouds.push({
                        kind: 'band', spr: null, seed: (rng() * 4294967296) >>> 0,
                        xn: -0.3 + (i / Math.max(1, n)) * 1.5 + rng() * 0.06,
                        yn: 0.985 + rng() * 0.025,
                        sp: (CFG.DY_SP ?? 0.0035) * (0.6 + rng() * 0.8),
                        s: 0.85 + rng() * 0.45, sw: 1.4 + rng() * 0.6, sh: 0.45 + rng() * 0.25
                    });
                }
                scheduleDay2();
            }
            function buildDay2Sprite(c) {
                const lr = mulberry32(c.seed);
                c.spr = c.kind === 'mass' ? makeDay2MassSprite(lr, c.spec) : makeDay2BandSprite(lr);
                day2Builds++;
            }
            // 스프라이트는 유휴 시간에 하나씩 굽는다(첫 화면 지연 방지). 낮이 먼저 필요해지면 ensureDay2가 남은 것을 즉시 굽는다.
            function scheduleDay2() {
                clearTimeout(day2Timer);
                const next = () => {
                    const c = day2Clouds.find(c => !c.spr);
                    if (!c) return;
                    buildDay2Sprite(c);
                    day2Timer = setTimeout(next, 30);
                };
                day2Timer = setTimeout(next, 400);
            }
            function ensureDay2() {
                for (const c of day2Clouds) if (!c.spr) buildDay2Sprite(c);
            }
            function day2Geom(c, base) {
                const sp = c.spr, pad = sp.pad, w0 = sp.w0, h0 = sp.h0;
                if (c.kind === 'mass') {
                    const S = c.spec;
                    // 가운데 덩어리는 좁은 화면에서 틈을 다 덮지 않게 너비로도 제한 (양옆 벽은 화면 밖으로 밀어낸다)
                    let k = S.hh * HZ / h0;
                    if (S.al === 0.5) k = Math.min(k, 2 * S.wmax * W / w0);
                    const cw = w0 * k, ch = h0 * k, pd = pad * k;
                    const over = Math.max(0, cw - S.wmax * W);
                    // 앞턱은 더 크게 흔들려 시차(parallax)가 생긴다. 뒷벽은 거의 고정.
                    const swayK = S.swayK ?? 1;
                    const sway = RM.matches ? 0 : W * (CFG.DY_SWAY ?? 0) * swayK * Math.sin(clock * 0.04 + c.ph);
                    const cx = S.ax * W - S.al * cw + (S.al < 0.5 ? -over : S.al > 0.5 ? over : 0) + sway;
                    return { px: pd, tw: cw + pd * 2, th: ch + pd * 2, dx: cx - pd, dy: S.ay * HZ - ch - pd };
                }
                const k = base * (c.s ?? 1), sx = c.sw ?? 1, sy = c.sh ?? 1;
                const cw = w0 * k * sx, ch = h0 * k * sy, px = pad * k * sx, py = pad * k * sy;
                return { px, tw: cw + px * 2, th: ch + py * 2, dx: c.xn * W - px, dy: c.yn * HZ - ch * 0.9 - py };
            }
            // 구름 틈 별(광원 둘레에 몰림) + 수면 반짝임 위치
            function buildDay2Extras() {
                const rng = mulberry32(919);
                day2Stars = [];
                for (let i = 0; i < 150; i++) {
                    const a = rng() * Math.PI * 2, r = Math.sqrt(rng());
                    day2Stars.push({
                        ox: Math.cos(a) * r * 0.26, oy: Math.sin(a) * r * 0.36 - 0.06,
                        d: 0.6 + rng() * rng() * 1.4, a: 0.35 + rng() * 0.65,
                        ph: rng() * Math.PI * 2, f: 0.5 + rng() * 1.5
                    });
                }
                glints = [];
                const ng = Math.max(0, Math.round(CFG.DY_GLINT_N));
                for (let i = 0; i < ng; i++) {
                    // 60%는 틈 빛 기둥 아래로 몰리게(3균등합 ≈ 종형), 나머지는 수면 전체에 고르게
                    const u = rng() < 0.6
                        ? CFG.DY_LX + (rng() + rng() + rng() - 1.5) * 0.22
                        : rng();
                    glints.push({ u: clamp(u, 0, 1), s: 0.04 + Math.pow(rng(), 0.85) * 0.96, ph: rng() * Math.PI * 2, f: 0.7 + rng() * 2.2, z: 0.5 + rng() * 0.8 });
                }
            }

            // ---------- 브러시 구름 문서 (편집: tsukuyomi.cloudedit.js, 셰이더·형식: cloud-doc.js) ----------
            // 출처 우선순위: 편집기에서 "장면에 적용"한 문서(localStorage) → public/clouds/index.json에 등록된 파일 → 없음(절차적 구름).
            // 문서는 하늘(W × HZ) 크기 투명 스프라이트로 구워 두고(resize마다 다시 굽는다) drawSet이 통째로 그린다.
            // 굽는 순간의 모양으로 고정되며 흐르지 않는다. 밤으로 갈 때는 기존 세트처럼 틴트로만 어두워진다.
            // live: 편집 모드에서 편집기가 매 획마다 다시 그리는 캔버스. 있으면 구운 스프라이트 대신 그린다(반사·틴트까지 그대로).
            const docCloud = {
                dusk: { isDoc: true, doc: null, spr: null, live: null, src: '' },
                day: { isDoc: true, doc: null, spr: null, live: null, src: '' }
            };
            let cloudIndex = null;
            const docOn = k => CFG.CLOUD_DOC >= 0.5 && !!(docCloud[k].live || docCloud[k].spr);
            function setCloudDoc(k, json, src) {
                const D = docCloud[k];
                try { D.doc = window.CloudDoc.parse(typeof json === 'string' ? JSON.parse(json) : json, k); D.src = src; }
                catch (e) { console.warn('구름 문서 읽기 실패 (' + k + ', ' + src + ')', e); D.doc = null; D.src = ''; }
                bakeCloudDoc(k);
            }
            function bakeCloudDoc(k) {
                const D = docCloud[k];
                D.spr = null;
                if (!D.doc || !W || !HZ) return;
                try { D.spr = window.CloudDoc.bake(D.doc, W, HZ, Math.min(dpr, 1.5)); }
                catch (e) { console.warn('구름 문서 굽기 실패 (' + k + ')', e); }
                // 라이브 렌더: 구운 한 장(D.spr)은 폴백/동작 줄이기용으로 두고, 평소엔 매 1/20초 다시 그린 캔버스를 쓴다
                if (window.CloudDoc.createLive && !RM.matches) {
                    try {
                        if (!D.anim || D.animDoc !== D.doc) { D.anim = window.CloudDoc.createLive(D.doc, { fps: 20 }); D.animDoc = D.doc; }
                        if (D.anim) { D.anim.resize(W, HZ, Math.min(dpr, 1.5) * 0.6); D.anim.tick(clock, true); }
                    } catch (e) { console.warn('구름 문서 라이브 렌더 실패 (' + k + ')', e); D.anim = null; }
                }
                if (D.spr) bandValid = false;
            }
            function loadCloudDoc(k) {
                let applied = null;
                try { applied = localStorage.getItem(window.CloudDoc.KEY.applied(k)); } catch (e) { /* 저장소 차단 */ }
                if (applied) { setCloudDoc(k, applied, 'editor'); return; }
                const file = cloudIndex && cloudIndex[k];
                if (!file) { docCloud[k].doc = null; docCloud[k].spr = null; docCloud[k].src = ''; return; }
                fetch(assetUrl('clouds/' + file), { cache: 'no-cache' })
                    .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
                    .then(j => setCloudDoc(k, j, 'file:' + file))
                    .catch(e => console.warn('구름 문서 파일을 불러오지 못함: clouds/' + file, e));
            }
            function loadCloudDocs() {
                if (!window.CloudDoc) return;
                fetch(assetUrl('clouds/index.json'), { cache: 'no-cache' })
                    .then(r => r.ok ? r.json() : null).catch(() => null)
                    .then(ix => {
                        cloudIndex = ix || {};
                        for (const k of window.CloudDoc.SCENES) {
                            if (k === 'dusk' && CFG.VIDEO >= 0.5) continue;   // dusk 슬롯은 비트팩 재생이 쓴다
                            loadCloudDoc(k);
                        }
                        if (CFG.VIDEO >= 0.5) loadVideo();
                    });
            }

            // ---------- 연속 프레임 재생 (1비트 흑백 영상, 셰이더 무수정) ----------
            // 비트팩을 가져와 den에 직접 적재하고 CloudDoc 렌더러 공개 API로 매 스텝 다시 굽는다.
            // 배경 질감 시간(uTime)은 프레임 스텝마다 VIDEO_TSPEED 배율로 전진한다 (원본 장면=1 기준).
            // docCloud.dusk 파이프를 그대로 쓰므로 레터박스·랜턴컬링·틴트·반사가 그대로 적용된다.
            // 팩 로드 실패 시 정적 문서로 폴백한다.
            const video = { pack: null, frames: [], n: 0, idx: -1, acc: 0, t: 20, tLast: -1, R: null, ready: false, allocKey: '' };
            const VID_W = 480, VID_H = 160;   // dusk 문서 스펙 (레터박스 VB_X 상수와 일치)
            const VID_E_ON = 2.2, VID_E_OFF = -2.0;
            function videoFPS() { return (CFG.VIDEO_FPS > 0 ? CFG.VIDEO_FPS : (video.pack && video.pack.fps)) || 8; }
            function loadVideo() {
                const file = CFG.VIDEO_SRC || 'ba-video.json';
                fetch(assetUrl('clouds/' + file), { cache: 'no-cache' })
                    .then(r => r.ok ? r.json() : Promise.reject(new Error(r.status)))
                    .then(p => {
                        if (!p || p.type !== 'tsukuyomi-video' || !Array.isArray(p.frames) || !p.frames.length) throw new Error('bad pack');
                        if (!(p.w > 0) || !(p.h > 0) || (p.enc && p.enc !== 'rle16')) throw new Error('bad pack header');
                        if (p.w > VID_W || p.h > VID_H) throw new Error('frame too large');
                        video.pack = p;
                        video.frames = p.frames;   // b64 문자열 보관, 디코드는 스텝마다 1장씩 (메모리 절약)
                        video.n = p.frames.length;
                        const D = docCloud.dusk;
                        D.doc = {
                            scene: 'dusk', w: VID_W, h: VID_H, horizon: 0, time: 20,
                            params: { cov: 0.5, sharp: 0.01, soft: 0.05, scale: 12, absorb: 0.2, sun: 90, grain: 0 },
                            den: new Float32Array(VID_W * VID_H), tr: new Float32Array(VID_W * VID_H),
                        };
                        D.src = 'video:' + file;
                        if (!video.R) video.R = window.CloudDoc.createRenderer(document.createElement('canvas'), { alpha: true });
                        if (!video.R.ok) throw new Error(video.R.error || 'renderer');
                        sizeVideoRenderer();
                        renderVideoFrame(0);
                        video.ready = true;
                    })
                    .catch(e => { console.warn('비디오 팩 로드 실패, 정적 문서로 폴백: clouds/' + file, e); loadCloudDoc('dusk'); });
            }
            function sizeVideoRenderer() {
                if (!video.R || !video.R.ok || !video.pack || !W || !HZ) return;
                const s = Math.min(dpr, 1.5);
                const cw = Math.max(1, Math.round(W * s)), ch = Math.max(1, Math.round(HZ * s));
                if (video.R.canvas.width !== cw || video.R.canvas.height !== ch) {
                    video.R.canvas.width = cw; video.R.canvas.height = ch;
                }
                const key = VID_W + 'x' + VID_H;
                if (video.allocKey !== key) {
                    video.R.alloc(VID_W, VID_H);
                    video.R.upload('tr', docCloud.dusk.doc.tr);
                    video.allocKey = key;
                }
                docCloud.dusk.spr = video.R.canvas;
                bandValid = false;
                // 캔버스 리사이즈로 내용이 지워졌으므로 현재 프레임을 강제 다시 그림
                if (video.frames.length) {
                    const cur = Math.max(0, video.idx);
                    video.idx = -1;
                    renderVideoFrame(cur);
                }
            }
            // v1(비트팩, enc 없음) / v2(rle16) 공용 1장 디코더. 위쪽 행이 먼저인 0/1 배열 반환.
            function decodeVideoFrame(p, b64) {
                const total = p.w * p.h;
                if (p.enc === 'rle16') {
                    const s = atob(b64);
                    const bin = new Uint8Array(total);
                    let idx = 0, v = 0;
                    for (let r = 0, n = s.length >> 1; r < n; r++) {
                        const len = s.charCodeAt(r * 2) | (s.charCodeAt(r * 2 + 1) << 8);
                        if (len < 0 || idx + len > total) throw new Error('rle overflow');
                        bin.fill(v, idx, idx + len);
                        idx += len; v ^= 1;
                    }
                    if (idx !== total) throw new Error('rle short');
                    return bin;
                }
                const s = atob(b64);
                if (s.length !== Math.ceil(total / 8)) throw new Error('frame size mismatch');
                const bin = new Uint8Array(total);
                for (let i = 0; i < total; i++) bin[i] = (s.charCodeAt(i >> 3) >> (7 - (i & 7))) & 1;
                return bin;
            }
            function renderVideoFrame(i, t) {
                if (!video.R || !video.R.ok || !video.frames.length || !W || !HZ) return;
                const time = t ?? video.t;
                if (i === video.idx && time === video.tLast) return;
                const p = video.pack, sameFrame = (i === video.idx);
                if (!sameFrame) {
                    const bin = decodeVideoFrame(p, video.frames[i]), dx0 = (VID_W - p.w) >> 1;
                    video.idx = i;
                    const d = docCloud.dusk.doc.den;
                    d.fill(VID_E_OFF);
                    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++)
                        d[(VID_H - 1 - y) * VID_W + dx0 + x] = bin[y * p.w + x] ? VID_E_ON : VID_E_OFF;
                    video.R.upload('den', d);
                }
                video.tLast = time;
                const D = docCloud.dusk, doc = D.doc, s = Math.min(dpr, 1.5);
                doc.time = time;
                const f = window.CloudDoc.fit(doc, W, HZ), A = VID_W / VID_H;
                video.R.render({
                    rect: [f.ox * s, -doc.horizon * f.k * s, A * f.k * s, f.k * s],
                    doc, preset: window.CloudDoc.PRESETS[doc.scene], mode: 1, view: 0, time,
                });
                D.spr = video.R.canvas;
            }
            // 에디터(다른 탭)에서 적용/해제하면 바로 반영
            window.addEventListener('storage', e => {
                if (!window.CloudDoc || !e.key) return;
                for (const k of window.CloudDoc.SCENES) if (e.key === window.CloudDoc.KEY.applied(k)) loadCloudDoc(k);
            });

            // 낮 구름 세트 (547f49e 시점 로직 그대로)
            function buildClouds() {
                const rng = mulberry32(42);
                clouds = [];
                const n = Math.max(0, Math.round(CFG.CLOUD_N));
                for (let i = 0; i < n; i++) {
                    clouds.push({
                        spr: makeCloudSprite(rng),
                        xn: CFG.CLOUD_X0 + (i / Math.max(1, n)) * CFG.CLOUD_SPREAD + rng() * 0.08,
                        yn: CFG.CLOUD_Y0 + rng() * CFG.CLOUD_YR,
                        sp: CFG.CLOUD_SP0 + rng() * CFG.CLOUD_SP1
                    });
                }
            }

            // 황혼 구름 스프라이트 기하: PAD 포함 전체 비트맵 기준 그리기 위치/크기.
            // update(랩어라운드)와 drawSky가 같은 식을 공유해 화면 끝 출현 팝을 막는다.
            function duskGeom(c, base) {
                const pad = c.spr.pad, w0 = c.spr.w0, h0 = c.spr.h0;
                if (c.kind === 'cb') {
                    const k = base * (c.s ?? 1);
                    const cw = w0 * k, ch = h0 * k, px = pad * k, py = pad * k;
                    return { k, cw, ch, px, py, tw: cw + px * 2, th: ch + py * 2, dx: c.xn * W - px, dy: c.yn * HZ - ch * 0.88 - py };
                }
                const k = base * (c.s ?? 1), sx = c.sw ?? 1, sy = c.sh ?? 1;
                const cw = w0 * k * sx, ch = h0 * k * sy, px = pad * k * sx, py = pad * k * sy;
                return { k, cw, ch, px, py, tw: cw + px * 2, th: ch + py * 2, dx: c.xn * W - px, dy: c.yn * HZ - ch * 0.9 - py };
            }

            // ---------- stone lanterns scattered on the flat ----------
            // lantern-front.svg (viewBox -130 -276 260x318): lantern body y -256..22,
            // feet at 298/318 of the image height, horizontally centred.
            const LAN_FEET = 298 / 318, LAN_WHR = 260 / 318;
            function buildLanterns() {
                const rng = mulberry32(Math.round(CFG.LANTERN_SEED * 1000 + 11));
                lanterns = [];
                const n = Math.max(0, Math.round(CFG.LANTERN_N));
                // 원근 분포: 수평선 쪽은 작은 랜턴이 빽빽하고 앞으로 올수록 드문드문.
                // 깊이는 층화 분위수 dq(0=수평선, 1=화면 아래) → projectLanterns에서
                // 밀도 sn^-K 역CDF로 sn을 구한다(바닥 균일 분포의 물리값은 K=3).
                // 가로는 황금비 수열 → (깊이, 가로)가 피보나치 격자처럼 고르게 퍼져
                // 뭉침/빈 구멍이 없다. 약한 지터로 격자 무늬만 흐린다.
                const PHI = 0.6180339887498949;
                const fx0 = rng();
                const jx = 0.6 / Math.sqrt(Math.max(1, n));
                for (let i = 0; i < n; i++) {
                    const dq = clamp((i + 0.5 + (rng() - 0.5) * 0.8) / n, 0, 1);
                    let fx = (fx0 + i * PHI + (rng() - 0.5) * jx) % 1;
                    if (fx < 0) fx += 1;
                    lanterns.push({ dq, ux: -1 + 2 * fx, sn: 0, x: 0, y: 0, w: 0, h: 0, s: 0 });
                }
                projectLanterns();
            }
            function projectLanterns() {
                if (!W || !H) return;
                const reflH = Math.max(1, H - HZ);
                const minS = 2;
                const halfW = W * clamp(CFG.LANTERN_GX, 0.05, 0.65);
                // TX: top-width ratio (1 = rectangle, 0 = vanishing point).
                // Old hardcoded 0.22 left ~41% of the floor empty at 16:9.
                const TX = clamp(CFG.LANTERN_TX ?? 1, 0.15, 1);
                const PAD = Math.max(0, CFG.LANTERN_PAD ?? 2);
                // 가장 먼 랜턴이 그려지는 최소 높이(3px, drawLanterns 컷)에 맞춰
                // 깊이 하한을 올린다 → 수평선 띠가 안 보이는 랜턴으로 낭비되지 않음.
                const lh = Math.max(1e-3, CFG.LANTERN_H);
                const sn1 = clamp(Math.max(CFG.LANTERN_SN0, CFG.LANTERN_SN1), 0.05, 1);
                const sn0 = clamp(Math.max(Math.min(CFG.LANTERN_SN0, CFG.LANTERN_SN1), 3.2 / (lh * reflH)), 0.005, sn1 * 0.98);
                const K = clamp(CFG.LANTERN_DEPTH_K ?? 2, 0, 3.5);
                const snOf = q => {
                    if (Math.abs(K - 1) < 1e-3) return sn0 * Math.pow(sn1 / sn0, q);
                    const e = 1 - K, a = Math.pow(sn0, e), b = Math.pow(sn1, e);
                    return Math.pow(a + q * (b - a), 1 / e);
                };
                for (const L of lanterns) {
                    L.sn = snOf(L.dq);
                    const s = clamp(L.sn * reflH, minS, reflH);
                    L.s = s;
                    L.x = W / 2 + L.ux * halfW * (TX + (1 - TX) * L.sn);
                    L.y = HZ + s;
                    L.h = Math.max(2, CFG.LANTERN_H * s);
                    L.w = L.h * LAN_WHR;
                }
                // keep clear of the bottom control UI (live-measured, null = no
                // avoidance). 토리이와는 겹침 방지 없이 앞/뒤 레이어로만
                // 구분한다(drawLanterns의 pass, 기준은 torBase).
                // card uses least-penetration with upward bias inside the resolver.
                resolveLanternOverlaps(PAD, measureCardZone());
                buildFarLanterns(reflH, sn0, K, halfW, TX, lh, lanterns.length / densInt(K, sn0, sn1));
            }
            // 하단 컨트롤 패널 회피 영역을 실측한다. LANTERN_CARD_AVOID=0이면
            // null(회피 없음). 구 하드코딩(중앙 500x170)은 UI가 좌하단으로
            // 옮기면서 중앙 하단에 stale void를 남겼으므로 삭제.
            const CARD_MARGIN = 14;
            function measureCardZone() {
                if (!(CFG.LANTERN_CARD_AVOID >= 0.5)) return null;
                try {
                    if (!elPanel || !elPanel.getBoundingClientRect) return null;
                    const r = elPanel.getBoundingClientRect();
                    if (!(r.width > 0 && r.height > 0)) return null;
                    return {
                        cardCx: r.left + r.width / 2,
                        cardHalf: r.width / 2 + CARD_MARGIN,
                        cardTop: r.top - CARD_MARGIN,
                    };
                } catch (e) { return null; }
            }
            // ∫ sn^-K dsn over [a, b]
            function densInt(K, a, b) {
                if (b <= a) return 0;
                if (Math.abs(K - 1) < 1e-3) return Math.log(b / a);
                const e = 1 - K;
                return (Math.pow(b, e) - Math.pow(a, e)) / e;
            }
            // ---------- 수평선 근접 경량 랜턴 ----------
            // 본 랜턴 밀도 곡선(c·sn^-K)을 수평선 쪽으로 이어 붙인 수천 개의 점 랜턴.
            // 스프라이트/그라디언트 없이 사각형 몇 개로 오프스크린 띠 캔버스에 1회 굽고
            // 매 프레임 drawImage 2~3회로 끝낸다(몸통=FG, 반사=scene ctx, 야간 글로우=lighter).
            const farBodyC = document.createElement('canvas');
            const farReflC = document.createElement('canvas');
            let farTop = 0, farBodyH = 0, farReflTop = 0, farReflH = 0, farCount = 0;
            function buildFarLanterns(reflH, snMain0, K, halfW, TX, lh, c) {
                farCount = 0;
                const y0 = Math.max(0.5, CFG.LANTERN_FAR_Y0 ?? 1.5);
                const snF0 = y0 / reflH;
                if (!(snF0 < snMain0) || !(c > 0)) { farBodyH = farReflH = 0; return; }
                const mul = Math.max(0, CFG.LANTERN_FAR_MUL ?? 1);
                const n = Math.min(Math.round(c * mul * densInt(K, snF0, snMain0)), Math.max(0, CFG.LANTERN_FAR_MAX ?? 4000) | 0);
                if (n <= 0) { farBodyH = farReflH = 0; return; }
                const snOf = q => {
                    if (Math.abs(K - 1) < 1e-3) return snF0 * Math.pow(snMain0 / snF0, q);
                    const e = 1 - K, a = Math.pow(snF0, e), b = Math.pow(snMain0, e);
                    return Math.pow(a + q * (b - a), 1 / e);
                };
                const maxH = lh * snMain0 * reflH;
                // 띠 영역: 몸통은 수평선 약간 위 ~ 본 랜턴 시작선, 반사는 그 아래로 같은 높이만큼
                farTop = Math.floor(HZ - maxH - 2);
                farBodyH = Math.ceil(snMain0 * reflH + maxH + 4);
                farReflTop = Math.floor(HZ);
                farReflH = Math.ceil(snMain0 * reflH + maxH * LAN_FEET + 4);
                const bw = Math.max(1, Math.round(W * dpr)), bh = Math.max(1, Math.round(farBodyH * dpr));
                const rh = Math.max(1, Math.round(farReflH * dpr));
                farBodyC.width = bw; farBodyC.height = bh;
                farReflC.width = bw; farReflC.height = rh;
                const BC = farBodyC.getContext('2d'), RC = farReflC.getContext('2d');
                BC.setTransform(dpr, 0, 0, dpr, 0, -farTop * dpr);
                RC.setTransform(dpr, 0, 0, dpr, 0, -farReflTop * dpr);
                BC.clearRect(0, farTop, W, farBodyH); RC.clearRect(0, farReflTop, W, farReflH);
                const rng = mulberry32(Math.round((CFG.LANTERN_SEED ?? 7) * 1000 + 977));
                const PHI = 0.6180339887498949, fx0 = rng();
                const jx = 0.6 / Math.sqrt(n);
                // 먼 것부터(위→아래) 칠해 가까운 점이 위에 오도록
                for (let i = 0; i < n; i++) {
                    const q = clamp((i + 0.5 + (rng() - 0.5) * 0.8) / n, 0, 1);
                    let fx = (fx0 + i * PHI + (rng() - 0.5) * jx) % 1;
                    if (fx < 0) fx += 1;
                    const sn = snOf(q);
                    const x = W / 2 + (-1 + 2 * fx) * halfW * (TX + (1 - TX) * sn);
                    if (x < -4 || x > W + 4) continue;
                    const y = HZ + sn * reflH;
                    const t = sn / snMain0;                       // 0 = 수평선, 1 = 본 랜턴 경계
                    const h = Math.max(0.8, lh * sn * reflH);
                    const w = Math.max(0.8, h * 0.62);
                    const al = 0.45 + 0.55 * t;                   // 대기 원근: 멀수록 옅게
                    // 몸통: 따뜻한 유리 + 위쪽 지붕 1/6
                    BC.fillStyle = `rgba(255,222,150,${al.toFixed(3)})`;
                    BC.fillRect(x - w / 2, y - h, w, h);
                    if (h >= 2) {
                        BC.fillStyle = `rgba(70,46,40,${(al * 0.8).toFixed(3)})`;
                        BC.fillRect(x - w * 0.6, y - h - h * 0.16, w * 1.2, h * 0.16);
                    }
                    // 반사: 아래로 늘어진 옅은 기둥
                    RC.fillStyle = `rgba(255,206,132,${(al * 0.55).toFixed(3)})`;
                    RC.fillRect(x - w / 2, y, w, h * 0.9 + 0.5);
                    farCount++;
                }
                bakeFarBloom();
            }
            // 랜턴 글로우 가중치: 황혼부터 켜져 있고(DUSK_GLOW) 밤에 최대(1)
            const lanGlowW = () => Math.max(ss(CFG.MOON_A0, CFG.MOON_A1, palQ()), clamp(CFG.LANTERN_DUSK_GLOW ?? 0.9, 0, 1));
            // 수평선 띠 블룸: 몸통 띠를 1/4, 1/10로 축소해 두 번 구워 두고 확대 합성 → 저비용 가우시안 근사.
            // 띠 위아래로 FAR_BLOOM_PAD만큼 여백을 둬 하늘/수면으로 번지게 한다.
            const farBloomA = document.createElement('canvas');
            const farBloomB = document.createElement('canvas');
            const FAR_BLOOM_PAD = 28;
            function bakeFarBloom() {
                const pad = FAR_BLOOM_PAD * dpr;
                const fullW = farBodyC.width, fullH = farBodyC.height + pad * 2;
                // 축소 평균으로 희석되는 밝기를 gain회 'lighter' 누적으로 보상
                const bake = (cv, k, gain) => {
                    cv.width = Math.max(1, Math.round(fullW / k));
                    cv.height = Math.max(1, Math.round(fullH / k));
                    const c = cv.getContext('2d');
                    c.setTransform(1, 0, 0, 1, 0, 0);
                    c.clearRect(0, 0, cv.width, cv.height);
                    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
                    c.globalCompositeOperation = 'lighter';
                    for (let g = 0; g < gain; g++) c.drawImage(farBodyC, 0, pad / k, cv.width, farBodyC.height / k);
                    c.globalCompositeOperation = 'source-over';
                };
                bake(farBloomA, 4, 3);
                bake(farBloomB, 10, 5);
            }
            function drawFarLanterns(a, night) {
                if (!farCount || a <= 0.01) return;
                const vb = videoBars();
                // 레터박스 바깥은 버린다: 전폭 버퍼에서 중앙 구간만 잘라 그린다 (vb 없으면 전폭 그대로)
                const nat = (c, img, dy) => {
                    if (!vb) { c.drawImage(img, 0, dy); return; }
                    const sx = vb[0] / W * img.width, sw = (vb[1] - vb[0]) / W * img.width;
                    c.drawImage(img, sx, 0, sw, img.height, sx, dy, sw, img.height);
                };
                const scl = (c, img, dy, dw, dh) => {
                    if (!vb) { c.drawImage(img, 0, dy, dw, dh); return; }
                    const f0 = vb[0] / W, f1 = vb[1] / W;
                    c.drawImage(img, f0 * img.width, 0, (f1 - f0) * img.width, img.height,
                        f0 * dw, dy, (f1 - f0) * dw, dh);
                };
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = a;
                nat(ctx, farReflC, Math.round(farReflTop * dpr));
                ctx.globalAlpha = 1;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                FG.setTransform(1, 0, 0, 1, 0, 0);
                FG.globalCompositeOperation = 'source-over';
                FG.globalAlpha = a;
                nat(FG, farBodyC, Math.round(farTop * dpr));
                if (night > 0.01) {
                    FG.globalCompositeOperation = 'lighter';
                    FG.globalAlpha = a * 0.45 * night * CFG.LANTERN_GLOW;
                    nat(FG, farBodyC, Math.round(farTop * dpr));
                    // 번짐: 축소 캔버스를 원래 크기로 늘려 그리면 부드럽게 퍼진다
                    const bl = a * night * CFG.LANTERN_GLOW * Math.max(0, CFG.LANTERN_FAR_BLOOM ?? 1);
                    if (bl > 0.005) {
                        const by = Math.round((farTop - FAR_BLOOM_PAD) * dpr);
                        const bw = farBodyC.width, bh = farBodyC.height + FAR_BLOOM_PAD * 2 * dpr;
                        FG.imageSmoothingEnabled = true;
                        FG.globalAlpha = Math.min(1, bl * 1.1);
                        scl(FG, farBloomA, by, bw, bh);
                        FG.globalAlpha = Math.min(1, bl * 1.4);
                        scl(FG, farBloomB, by, bw, bh);
                    }
                    FG.globalCompositeOperation = 'source-over';
                }
                FG.globalAlpha = 1;
                FG.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
            // AABB relaxation in screen space: bodies must not intersect.
            // Sizes stay fixed (depth cue); only positions move. Deterministic
            // (no rng here) so a seed always yields the same layout.
            function resolveLanternOverlaps(PAD, obs) {
                const n = lanterns.length;
                if (n === 0) return;
                // obs == null: 카드 회피 끔(또는 측정 실패). 겹침 판정이 항상
                // 음수가 되도록 화면 밖 센티넬로 대체한다(루프 구조는 그대로).
                if (!obs) obs = { cardCx: -1e9, cardHalf: 0, cardTop: 1e9 };
                const hhOf = L => L.h * LAN_FEET;
                // allow drifting fully off-screen to relieve pressure on narrow
                // layouts; fully hidden lanterns are skipped below and cost nothing.
                const sync = L => {
                    L.x = clamp(L.x, -L.w, W + L.w);
                    L.y = clamp(L.y, HZ + 2, H);
                };
                const hidden = L => (L.x + L.w / 2 < 0 || L.x - L.w / 2 > W);
                for (const L of lanterns) sync(L);
                // first: card least-penetration with upward bias (replaces x-only)
                const { cardCx, cardHalf, cardTop } = obs;
                for (const L of lanterns) {
                    const hh = hhOf(L);
                    const lx0 = L.x - L.w / 2, lx1 = L.x + L.w / 2;
                    const ly0 = L.y - hh, ly1 = L.y;
                    const ox = Math.min(lx1, cardCx + cardHalf) - Math.max(lx0, cardCx - cardHalf) + PAD;
                    const oy = Math.min(ly1, H) - Math.max(ly0, cardTop) + PAD;
                    if (ox > 0 && oy > 0) {
                        if (ox < oy) {
                            L.x = cardCx + (L.x < cardCx ? -(cardHalf + L.w / 2 + PAD) : (cardHalf + L.w / 2 + PAD));
                        } else {
                            L.y = cardTop - PAD;   // hop above the card, never below
                        }
                        sync(L);
                    }
                }
                const MAX_IT = 120;
                for (let it = 0; it < MAX_IT; it++) {
                    for (let i = 0; i < n; i++) {
                        const A = lanterns[i];
                        if (hidden(A)) continue;
                        const ah = hhOf(A);
                        for (let j = i + 1; j < n; j++) {
                            const B = lanterns[j];
                            if (hidden(B)) continue;
                            const bh = hhOf(B);
                            const dx = B.x - A.x;
                            const ox = (A.w + B.w) / 2 + PAD - Math.abs(dx);
                            if (ox <= 0) continue;
                            const dcy = (B.y - bh / 2) - (A.y - ah / 2);
                            const oy = (ah + bh) / 2 + PAD - Math.abs(dcy);
                            if (oy <= 0) continue;
                            const aa = A.w * ah, bb = B.w * bh, tot = aa + bb || 1;
                            const wa = bb / tot, wb = aa / tot;
                            if (ox < oy) {
                                const s = dx >= 0 ? 1 : -1;
                                A.x -= s * ox * wa * 0.85;
                                B.x += s * ox * wb * 0.85;
                                sync(A); sync(B);
                            } else {
                                const s = dcy >= 0 ? 1 : -1;
                                A.y -= s * oy * wa * 0.85;
                                B.y += s * oy * wb * 0.85;
                                sync(A); sync(B);
                            }
                        }
                    }
                    // card keeps least-penetration with upward bias.
                    for (const L of lanterns) {
                        if (hidden(L)) continue;
                        const hh = hhOf(L);
                        const lx0 = L.x - L.w / 2, lx1 = L.x + L.w / 2;
                        const ly0 = L.y - hh, ly1 = L.y;
                        const ox = Math.min(lx1, cardCx + cardHalf) - Math.max(lx0, cardCx - cardHalf) + PAD;
                        const oy = Math.min(ly1, H) - Math.max(ly0, cardTop) + PAD;
                        if (ox > 0 && oy > 0) {
                            if (ox < oy) {
                                L.x = cardCx + (L.x < cardCx ? -(cardHalf + L.w / 2 + PAD) : (cardHalf + L.w / 2 + PAD));
                            } else {
                                L.y = cardTop - PAD;
                            }
                            sync(L);
                        }
                    }
                    // stop as soon as bodies no longer intersect
                    // (sub-PAD gaps are acceptable and often unavoidable)
                    let ok = true;
                    for (let i = 0; i < n && ok; i++) {
                        const A = lanterns[i];
                        if (hidden(A)) continue;
                        const ah = hhOf(A);
                        for (let j = i + 1; j < n; j++) {
                            const B = lanterns[j];
                            if (hidden(B)) continue;
                            const bh = hhOf(B);
                            if (Math.abs(B.x - A.x) < (A.w + B.w) / 2 &&
                                Math.abs((B.y - bh / 2) - (A.y - ah / 2)) < (ah + bh) / 2) {
                                ok = false; break;
                            }
                        }
                    }
                    if (ok) break;
                }
                lanterns.sort((a, b) => a.y - b.y);   // far-to-near painter order
            }
            function loadLanternSprite() {
                try {
                    lanImg = new Image();
                    lanImg.decoding = 'async';
                    lanImg.onload = () => {
                        try {
                            const nw = lanImg.naturalWidth || 416;
                            const nh = lanImg.naturalHeight || 509;
                            lanC.width = nw; lanC.height = nh;
                            LC.setTransform(1, 0, 0, 1, 0, 0);
                            LC.globalCompositeOperation = 'source-over';
                            LC.globalAlpha = 1;
                            LC.clearRect(0, 0, nw, nh);
                            LC.drawImage(lanImg, 0, 0, nw, nh);
                            lanCW = nw; lanCH = nh;
                            lanBodyH = nh * LAN_FEET;
                            lanReady = true;
                        } catch (e) { lanReady = false; }
                    };
                    lanImg.onerror = () => { lanReady = false; };
                    lanImg.src = assetUrl('lantern-front.svg');
                } catch (e) { lanReady = false; }
            }

            // ---------- stars and their trails ----------
            // Each trail runs from where the star was phiLen radians ago to where it is now.
            // It grows from the star's starting point until it reaches TRAIL_LEN, then keeps that length.
            function drawStars() {
                const a = starAlpha();
                if (a <= 0.003) return;
                const len = phiTail === null ? 0 : clamp(phi - phiTail, 0, CFG.TRAIL_LEN);
                S.globalCompositeOperation = 'lighter';
                S.lineCap = 'butt';
                for (let k = 0; k < 12; k++) {
                    const b = buckets[k];
                    if (!b.length) continue;
                    const L = LV[(k / 3) | 0];
                    const col = rgba(COLS[k % 3], L.al * a);
                    const rad = L.d / 2;
                    if (len > 0.0005) {
                        S.strokeStyle = col;
                        S.lineWidth = L.d;
                        S.beginPath();
                        for (const s of b) {
                            const r = s.rAbs ?? s.rn * R;
                            const head = s.th - phi, tail = head + len;   // decreasing angle = counter-clockwise on screen
                            S.moveTo(pole.x + r * Math.cos(tail), pole.y + r * Math.sin(tail));
                            S.arc(pole.x, pole.y, r, tail, head, true);
                        }
                        S.stroke();
                    }
                    S.fillStyle = col;
                    S.beginPath();
                    for (const s of b) {
                        const r = s.rAbs ?? s.rn * R;
                        const ang = s.th - phi;
                        const x = pole.x + r * Math.cos(ang), y = pole.y + r * Math.sin(ang);
                        if (x < -3 || x > W + 3 || y < -3 || y > HZ + 3) continue;
                        S.moveTo(x + rad, y);
                        S.arc(x, y, rad, 0, Math.PI * 2);
                    }
                    S.fill();
                }
                S.globalCompositeOperation = 'source-over';
            }

            // ---------- layout ----------
            // 모바일 레이아웃(CSS .dock 브레이크포인트와 동일)에서는 토리이/달을
            // 화면 정가운데(x=0.5)에 고정. PC 레이아웃에서는 CFG.TORII_X 그대로.
            function isMobileLayout() {
                try {
                    return window.matchMedia('(max-width: 460px), (pointer: coarse) and (max-height: 500px)').matches;
                } catch (e) { /* matchMedia 미지원 시 PC 값으로 폴백 */ return false; }
            }
            function effToriiX() {
                if (isMobileLayout()) return 0.5;
                return CFG.TORII_X;
            }
            function resize() {
                W = window.innerWidth; H = window.innerHeight;
                // 레이아웃 전환 시 랜턴 기본값 추종: 사용자가 N을 직접 바꾸지 않은 경우에만 전환.
                const mob = isMobileLayout();
                if (mob !== lastMobile) {
                    const prevDef = lastMobile ? LANTERN_N_MOBILE : LANTERN_N_PC;
                    const nextDef = mob ? LANTERN_N_MOBILE : LANTERN_N_PC;
                    lastMobile = mob;
                    CFG_DEFAULTS.LANTERN_N = nextDef;
                    if (Math.round(CFG.LANTERN_N) === prevDef) {
                        CFG.LANTERN_N = nextDef;
                        buildLanterns();
                    }
                }
                dpr = Math.min(CFG.DPR_MAX, window.devicePixelRatio || 1);
                if (W * H * dpr * dpr > CFG.PIX_BUDGET) dpr = Math.max(1, Math.sqrt(CFG.PIX_BUDGET / (W * H)));
                HZ = Math.round(H * CFG.HZ_RATIO);
                cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
                bandH = Math.round((H - HZ) * CFG.BAND_H);
                band.width = Math.ceil(W * dpr / BAND_SCALE);
                band.height = Math.ceil((bandH + CFG.BAND_PAD * 2) * dpr / BAND_SCALE);
                bandValid = false;   // 크기 변경 시 블러 캐시 무효
                for (const c of [sky, cloudLayer]) {
                    c.width = Math.round(W * dpr); c.height = Math.round(HZ * dpr);
                }
                pole = { x: W * CFG.POLE_X, y: HZ * CFG.POLE_Y };
                placeDuskCb();
                for (const k in docCloud) {
                    if (k === 'dusk' && CFG.VIDEO >= 0.5 && video.pack) sizeVideoRenderer();
                    else bakeCloudDoc(k);
                }
                const m = Math.min(W, H);
                sunR = clamp(m * CFG.SUN_F, CFG.SUN_MIN, CFG.SUN_MAX);
                moonR = clamp(m * CFG.MOON_F, CFG.MOON_MIN, CFG.MOON_MAX) * (CFG.MOON_SIZE ?? 1);
                // torii: centred on the shared vertical line (CFG.TORII_X), standing on the flat with
                // its base three quarters of the way up from the bottom edge to the horizon
                torS = CFG.TORII_SCALE * Math.min(HZ * 0.30 / 356, W * 0.40 / 428);
                torW = TB.w * torS; torH = TB.h * torS;
                torBase = H - CFG.TORII_BASE * (H - HZ);
                torX = W * effToriiX() - (340 - TB.x) * torS;
                torY = torBase - (TB.base - TB.y) * torS;
                for (const c of [torC, torR]) fitCanvas(c, Math.max(1, Math.ceil(torW * dpr)), Math.max(1, Math.ceil(torH * dpr)));
                // NOTE: 같은 값을 대입해도 비트맵이 지워지므로 fitCanvas 가드가 필수.
                // 무조건 대입하면 토리이 형상과 무관한 resize(MOON_SIZE 등) 때
                // 캐시 키가 그대로라 스프라이트가 다시 그려지지 않고 토리이가 사라진다.
                fg.width = cv.width; fg.height = cv.height;
                resizeRipple();
                buildStars();
                projectLanterns();
            }

            // ---------- update ----------
            // 고속 회전 단계 없음: 별 궤적 길이는 달 상승 보간(mt)에 동기화되고,
            // 궤적 성장 중에도 꼬리가 W_SLOW로 항상 전진하므로 완료 시점에 멈춤이 없다.
            // 궤적 생성 시작(mt > 0) = q > TRAIL_A0, 완료(mt = 1) = q >= TRAIL_A1.
            // 달 상승(MOON_A0/A1)과 분리된 전용 구간으로 궤적만 0.75배 감속. 달 위치·발광은 MOON_* 그대로.
            // 최종 궤적 길이는 TRAIL_LEN 그대로 유지된다.
            function update(dt) {
                if (debugPaused) return;
                clock += dt;
                if (!debugHold) {
                if (state === 'toNight') {
                    tState += dt;
                    const k = Math.min(1, tState / CFG.T_NIGHT);
                    // 전반 가속 ease-out: e = 1-(1-k)^GAMMA. 낮 출발의 전반부(파랑→주황) 정체를 줄이고,
                    // 후반(궤적·달)은 완만하게. 일몰(nk)은 기존 선형 pace 유지.
                    const gm = Math.max(0.2, CFG.TN_GAMMA ?? 1.5);
                    const e = 1 - Math.pow(1 - k, gm);
                    p = transFrom + (1 - transFrom) * e;
                    duskW = duskFrom + (1 - duskFrom) * e;
                    // 일몰(nk)만 별도 속도로: 하늘/별궤적은 T_NIGHT 그대로 두고 해 지는 속도만 T_SUNSET으로 조절.
                    const nkK = Math.min(1, tState / Math.max(1e-4, CFG.T_SUNSET));
                    nk = nkFrom + (1 - nkFrom) * nkK;
                    if (k >= 1) {
                        state = 'night'; tNight = 0; p = 1; nk = 1;
                        duskW = 1; duskFrom = 1; duskTo = 1;
                    }
                } else if (state === 'night') {
                    tNight += dt;
                } else if (state === 'toDusk' || state === 'toDay') {
                    tState += dt;
                    const k = Math.min(1, tState / CFG.T_DAY);
                    const e = ss(0, 1, k);
                    p = transFrom + (transTo - transFrom) * e;
                    duskW = duskFrom + (duskTo - duskFrom) * e;
                    nk = nkFrom + (nkTo - nkFrom) * e;
                    sunVis = svFrom + (svTo - svFrom) * e;
                    omega *= Math.exp(-dt * 3);
                    if (k >= 1) {
                        state = transTarget; p = transTo;
                        duskW = duskTo;
                        nk = nkTo;
                        sunVis = svTo;
                        phi = 0; phiTail = null; omega = 0;
                        // 낮/황혼 도착: 달이 졌으므로 다음 밤은 일반 달로 시작
                        moonTarget = 'plain'; mbMix = 0; mbPending = false;
                    }
                } else {
                    // 'day'(낮 idle) / 'dusk'(황혼 idle) 모두 정지 상태
                    omega = 0;
                }
                }

                // 별 회전 / 궤적: 궤적 성장 중에도 기본 회전(W_SLOW)은 항상 진행한다.
                // phiTail(꼬리)이 W_SLOW로 전진하면서 head = phiTail + TRAIL_LEN*mt로 성장하므로
                // 성장 완료 시점(mt=1)의 속도가 W_SLOW로 자연스럽게 이어지고 멈춤 구간이 없다.
                // hold(수동 스크럽) 중에는 꼬리를 고정해 p에 대한 결정성을 유지한다.
                if (state === 'toNight') {
                    const m = ss(CFG.TRAIL_A0, CFG.TRAIL_A1, palQ());
                    const mt = 1 - Math.pow(1 - m, 3);
                    if (m <= 0) {
                        phi = 0; phiTail = null; omega = 0;
                    } else if (m < 1) {
                        const prev = phi;
                        if (phiTail === null) phiTail = 0;
                        else if (!debugHold) phiTail += CFG.W_SLOW * dt;
                        phi = phiTail + CFG.TRAIL_LEN * mt;
                        omega = dt > 0 ? Math.max(0, (phi - prev) / dt) : 0;
                    } else {
                        if (phiTail === null) { phi = Math.max(phi, CFG.TRAIL_LEN); phiTail = phi - CFG.TRAIL_LEN; }
                        omega = CFG.W_SLOW;
                        phi += omega * dt;
                        phiTail = phi - CFG.TRAIL_LEN;
                    }
                } else if (state === 'night') {
                    if (phiTail === null) {
                        if (phi < CFG.TRAIL_LEN) phi = CFG.TRAIL_LEN;
                        phiTail = phi - CFG.TRAIL_LEN;
                    }
                    omega = CFG.W_SLOW;
                    phi += omega * dt;
                    phiTail = phi - CFG.TRAIL_LEN;
                } else if (state === 'toDusk' || state === 'toDay') {
                    // 복귀 시에는 궤적을 되감지 않고 고정 길이로 서서히 멈춘 뒤 페이드아웃
                    if (phiTail !== null && !debugHold) {
                        phi += omega * dt;
                        phiTail = phi - CFG.TRAIL_LEN;
                    }
                }

                if (!RM.matches) {
                    // 낮 구름 (547f49e 시점 그대로)
                    for (const c of clouds) {
                        c.xn += c.sp * dt;
                        if (c.xn > 1.25) c.xn = -0.4;
                    }
                    const base = clamp(W / 1400, 0.5, 1.1);
                    for (const c of duskClouds) {
                        c.xn += c.sp * dt * 0.75;
                        const G = duskGeom(c, base);
                        // 왼쪽이 화면 오른쪽 밖으로 완전히 나가면 너비만큼 왼쪽 밖으로 되돌림 (팝인 없음)
                        if (G.dx > W) c.xn = (-G.tw - 8 + G.px) / W;
                    }
                    // 새 낮 수평선 띠 (큰 덩어리는 day2Geom에서 제자리 흔들림만)
                    for (const c of day2Clouds) {
                        if (c.kind !== 'band') continue;
                        c.xn += c.sp * dt;
                        if (!c.spr) continue;
                        const G = day2Geom(c, base);
                        if (G.dx > W) c.xn = (-G.tw - 8 + G.px) / W;
                    }
                }

                // 연속 프레임 재생: 고정 fps로 den을 갈아끼우고 다시 굽는다 (동작 줄이기 설정이면 첫 장면 정지).
                // 배경 질감 시간도 같은 스텝에 VIDEO_TSPEED 배율로 전진 — 렌더 횟수는 그대로라 추가 비용 없음.
                if (CFG.VIDEO >= 0.5 && video.ready && !RM.matches) {
                    video.acc += dt;
                    const vstep = 1 / Math.max(1, videoFPS());
                    if (video.acc >= vstep) {
                        video.acc = video.acc % vstep;
                        video.t += vstep * Math.max(0, CFG.VIDEO_TSPEED ?? 8);
                        try { renderVideoFrame((video.idx + 1) % video.n, video.t); }
                        catch (e) {
                            console.warn('비디오 프레임 디코드 실패, 정지 후 정적 문서로 폴백', e);
                            CFG.VIDEO = 0; video.ready = false;
                            loadCloudDoc('dusk');
                        }
                    }
                }

                // 미러볼 자전(40초/회) + 줄눈 빛줄기 진행. 동작 줄이기 설정이면 회전·빛줄기 모두 정지.
                if (!RM.matches) {
                    if (mbSpin) mbRot = (mbRot + dt * 360 / MB_PERIOD) % 360;
                    mbT += dt;
                    mbUpdateStreaks();
                }
                updateMoonMode(dt);
            }

            // ---------- render ----------
            // 새 낮: 구름 뒤에서 퍼지는 틈의 청백색 빛 + 그 둘레로 비치는 옅은 별
            // ref: 빛은 틈 안쪽의 좁은 코어 + 그 둘레의 옅은 헤일로뿐, 하늘 전체를 씻는 넓은 글로우가 아니다.
            // 코어/헤일로 2중으로 좁혀 그려 하늘 코발트 그라데이션과 별이 살아나게 한다(수정 전엔 반경 화면절반 글로우가 하늘을 덮었음).
            function drawDay2Light(lx, ly, a) {
                const A = CFG.DY_LIGHT * (CFG.DY_GLOW_A ?? 1) * a;
                const RS = CFG.DY_GLOW_R ?? 1;
                const CK = CFG.DY_GLOW_CORE ?? 1;
                S.save();
                S.translate(lx, ly);
                // 원형: 타원 스케일 제거 (수정 전 scale(1, 1.4))
                // 헤일로: 틈 둘레 하늘을 옅게 밝히는 청색 산란
                const hr = HZ * 0.88 * RS;
                const hg = S.createRadialGradient(0, 0, 0, 0, 0, hr);
                hg.addColorStop(0, rgba(hex('#a9d6f0'), Math.min(1, 0.2 * A)));
                hg.addColorStop(0.4, rgba(hex('#7cb8e2'), 0.08 * A));
                hg.addColorStop(1, 'rgba(80,140,205,0)');
                S.fillStyle = hg;
                S.fillRect(-hr, -hr, hr * 2, hr * 2);
                // 코어: 틈 안쪽의 밝은 빛덩어리 (구름이 그 위에 그려져 아랫부분은 가려진다)
                const cr = HZ * 0.21 * RS;
                const cg = S.createRadialGradient(0, 0, 0, 0, 0, cr);
                cg.addColorStop(0, rgba(hex('#f4fbff'), Math.min(1, 0.42 * A * CK)));
                cg.addColorStop(0.35, rgba(hex('#d8edfa'), 0.24 * A * CK));
                cg.addColorStop(1, 'rgba(160,210,240,0)');
                S.fillStyle = cg;
                S.fillRect(-cr, -cr, cr * 2, cr * 2);
                S.restore();
                const sa = CFG.DY_STAR_A * a;
                if (sa > 0.01) {
                    S.globalCompositeOperation = 'lighter';
                    S.fillStyle = '#eef5ff';
                    for (const st of day2Stars) {
                        const tw = RM.matches ? 0.8 : 0.6 + 0.4 * Math.sin(clock * st.f + st.ph);
                        const al = sa * st.a * tw;
                        if (al < 0.01) continue;
                        S.globalAlpha = Math.min(1, al);
                        S.beginPath();
                        S.arc(lx + st.ox * W, ly + st.oy * HZ, st.d / 2, 0, Math.PI * 2);
                        S.fill();
                    }
                    S.globalAlpha = 1;
                    S.globalCompositeOperation = 'source-over';
                }
            }
            // 새 낮: 수면 반짝임. 반사된 하늘이 밝은 곳(썸네일 휘도)에서만 깜빡인다
            function drawGlints(w, q) {
                const a0 = CFG.DY_GLINT_A * w * (1 - ss(CFG.DY_F0, CFG.DY_F1, q));
                if (a0 < 0.01 || !glints.length) return;
                if (!thumbData || (thumbTick % 15) === 0) {
                    TH.setTransform(1, 0, 0, 1, 0, 0);
                    TH.drawImage(sky, 0, 0, thumb.width, thumb.height);
                    thumbData = TH.getImageData(0, 0, thumb.width, thumb.height).data;
                }
                thumbTick++;
                const D = thumbData, TW = thumb.width, THh = thumb.height, reflH = H - HZ;
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = '#e8f4ff';
                for (const gl of glints) {
                    const d = gl.s * reflH, my = HZ - d;
                    if (my < 0) continue;
                    const ix = clamp((gl.u * TW) | 0, 0, TW - 1), iy = clamp((my / HZ * THh) | 0, 0, THh - 1);
                    const j = (iy * TW + ix) * 4;
                    const L = (0.3 * D[j] + 0.59 * D[j + 1] + 0.11 * D[j + 2]) / 255;
                    const lum = ss(0.32, 0.7, L);
                    if (lum <= 0) continue;
                    const tw = RM.matches ? 0.45 : Math.pow(Math.max(0, Math.sin(clock * gl.f + gl.ph)), 4);
                    const al = a0 * lum * tw;
                    if (al < 0.02) continue;
                    const sz = gl.z * (0.8 + 1.8 * gl.s);
                    ctx.globalAlpha = Math.min(1, al);
                    ctx.fillRect(gl.u * W - sz, HZ + d - sz * 0.35, sz * 2, sz * 0.7);
                }
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
            }
            function drawSky() {
                S.setTransform(dpr, 0, 0, dpr, 0, 0);
                S.globalCompositeOperation = 'source-over';
                S.globalAlpha = 1;

                const q = palQ();
                const skyC = skyAt(q);
                const hor = skyC[skyC.length - 1];
                const g = S.createLinearGradient(0, 0, 0, HZ);
                for (let i = 0; i < skyC.length; i++) g.addColorStop(SKY_STOPS[i], rgba(skyC[i]));
                S.fillStyle = g; S.fillRect(0, 0, W, HZ);

                // 새 낮(DAY_SCENE=1) 가중치: 낮 분기(sunVis) 중 새 낮 몫. 나머지(sunVis - w2)가 기존 낮(더미).
                const w2 = day2W();
                const d2Live = w2 * (1 - ss(CFG.DY_F0, CFG.DY_F1, q));
                const d2lx = W * CFG.DY_LX, d2ly = HZ * CFG.DY_LY;
                if (d2Live > 0.005) drawDay2Light(d2lx, d2ly, d2Live);

                // sun path (낮/황혼 공통: 정규화 진행도 nk 기준이라 시작 고도가 동일)
                const nk = sunK();
                const sp = clamp(nk / CFG.SUN_PATH, 0, 1);
                const sx = lerp(W * CFG.SUN_X0, W * CFG.SUN_X1, sp);
                const sy0 = HZ * 0.3;
                const sy = lerp(sy0, HZ + sunR * CFG.SUN_DROP, sp * sp);

                // afterglow along the horizon (brief)
                // 새 낮은 주황 여광 없이 블루 아워로 넘어간다
                const glowA = ss(CFG.SUN_G0, CFG.SUN_G1, nk) * (1 - ss(CFG.SUN_G2, CFG.SUN_G3, nk)) * (1 - w2);
                if (glowA > 0.005) {
                    S.save();
                    S.translate(W * 0.32, HZ);
                    S.scale(3.2, 1);
                    const rg = S.createRadialGradient(0, 0, 0, 0, 0, HZ * 0.55);
                    rg.addColorStop(0, rgba(hex('#ff8f52'), 0.55 * glowA));
                    rg.addColorStop(0.45, rgba(hex('#ff6f6a'), 0.22 * glowA));
                    rg.addColorStop(1, 'rgba(255,110,100,0)');
                    S.fillStyle = rg;
                    S.fillRect(-W, -HZ, W * 2, HZ);
                    S.restore();
                }

                // sun (소멸도 nk 기준: 낮/황혼 동일한 타이밍)
                // 태양 원반은 기존 낮(더미)에만: 새 낮은 해가 구름 뒤에 가려 틈의 빛으로만 보인다
                const sunFade = (1 - ss(CFG.SUN_F0, CFG.SUN_F1, nk)) * (sunVis - w2);
                if (sy < HZ + sunR * 3 && sunFade > 0.001) {
                    const hgt = clamp((HZ - sy) / (HZ - sy0), 0, 1);
                    const sc = hgt > 0.35
                        ? mix(hex('#ffc070'), hex('#fffbef'), (hgt - 0.35) / 0.65)
                        : mix(hex('#ff5a2a'), hex('#ffc070'), hgt / 0.35);
                    const gr = sunR * (4 + 10 * (1 - hgt));
                    const sg = S.createRadialGradient(sx, sy, sunR * 0.6, sx, sy, gr);
                    sg.addColorStop(0, rgba(sc, (0.38 + 0.25 * (1 - hgt)) * sunFade));
                    sg.addColorStop(1, rgba(sc, 0));
                    S.fillStyle = sg;
                    S.beginPath(); S.arc(sx, sy, gr, 0, Math.PI * 2); S.fill();
                    S.fillStyle = rgba(sc, 1);
                    S.beginPath(); S.arc(sx, sy, sunR, 0, Math.PI * 2); S.fill();
                }

                // 낮/황혼 구름 세트 가중치: sunVis(낮=1, 황혼=0)로만 갈린다. q와 무관하므로
                // 낮→밤 전환에는 낮 구름만, 황혼→밤 전환에는 황혼 구름만 나온다.
                const wD = 1 - sunVis;
                const dLive = wD * (1 - ss(CFG.DC_F0, CFG.DC_F1, q));
                // 황혼: 원반 대신 화면 밖 좌상단 광원의 은은한 빛 (구름 상부 반사 방향과 일치)
                const lx = W * CFG.DC_LX, ly = HZ * CFG.DC_LY;
                const lA = CFG.DC_LIGHT * dLive;
                if (lA > 0.005) {
                    const lg = S.createRadialGradient(lx, ly, 0, lx, ly, HZ * 1.1);
                    lg.addColorStop(0, rgba(hex('#fff0d8'), 0.75 * lA));
                    lg.addColorStop(0.35, rgba(hex('#f8c8b8'), 0.32 * lA));
                    lg.addColorStop(1, 'rgba(240,180,190,0)');
                    S.fillStyle = lg; S.fillRect(0, 0, W, HZ);
                }

                // clouds: 낮 세트(547f49e 로직, 틴트 방식)와 황혼 세트(색 구움)를 sunVis로 크로스페이드
                const base = clamp(W / 1400, 0.5, 1.1);
                const drawSet = (set, tint, alpha, light) => {
                    drawSetInner(set, tint, alpha, light);
                    if (CFG.BLOOM > 0.005 && alpha > 0.01) drawBloom(alpha);
                };
                const drawSetInner = (set, tint, alpha, light) => {
                    if (cloudLive && Array.isArray(set)) { const nowMs = performance.now(); for (const c of set) if (c.spr) cloudLive.touch(c.spr, nowMs); }
                    CL.setTransform(1, 0, 0, 1, 0, 0);
                    CL.globalCompositeOperation = 'source-over';
                    CL.clearRect(0, 0, cloudLayer.width, cloudLayer.height);
                    CL.setTransform(dpr, 0, 0, dpr, 0, 0);
                    if (set.isDoc) {
                        // 브러시 구름 문서: 하늘 크기 스프라이트 한 장 (편집 중이면 편집기의 라이브 캔버스)
                        CL.drawImage(set.live || (set.anim && set.anim.canvas) || set.spr, 0, 0, W, HZ);
                    } else if (set === clouds) {
                        // 낮 구름 배치 (547f49e 시점 식 그대로, PAD 여백만 보정)
                        for (const c of set) {
                            const k = base * lerp(1, 0.4, (c.yn - CFG.CLOUD_Y0) / (CFG.CLOUD_YR || 1));
                            const sp = c.spr, cw = sp.w0 * k, ch = sp.h0 * k, pd = sp.pad * k;
                            CL.drawImage(sp, c.xn * W - pd, c.yn * HZ - ch * 0.7 - pd, cw + pd * 2, ch + pd * 2);
                        }
                    } else if (set === day2Clouds) {
                        ensureDay2();
                        // 2층 합성: 먼 띠 + 뒷층(림층) 먼저 → 틈 라이트 → 앞턱(음영층) 나중에. 앞이 뒤를 가려 깊이가 생긴다
                        const isFront = c => c.kind === 'mass' && c.spec.layer === 'front';
                        CL.globalCompositeOperation = 'source-over';
                        for (const c of set) {
                            if (isFront(c)) continue;
                            const G = day2Geom(c, base);
                            if (G.dx > W || G.dx + G.tw < 0) continue;
                            CL.drawImage(c.spr, G.dx, G.dy, G.tw, G.th);
                        }
                        // 뒷층 림라이트: 틈의 광원에 가까운 가장자리일수록 청백색으로 타오른다 (앞층 그리기 전이라 뒷층만 밝힌다).
                        // 수직 페이드(DY_RIMBOT): 빛을 스크래치에 그려 destination-in 수직 마스크로 자른 뒤 CL에 source-atop 합성.
                        // 구름 알파는 그대로 두고 빛만 아래로 옅어지므로, 하부 구름층·수평선에는 닿지 않고 상부·뒷층·배경만 밝힌다.
                        fitCanvas(rimL, cloudLayer.width, cloudLayer.height);
                        RL.setTransform(1, 0, 0, 1, 0, 0);
                        RL.globalCompositeOperation = 'source-over';
                        RL.clearRect(0, 0, rimL.width, rimL.height);
                        {
                            const rr = Math.max(W, HZ) * 0.38 * dpr;
                            const cx = d2lx * dpr, cy = d2ly * dpr;
                            const rg = RL.createRadialGradient(cx, cy, 0, cx, cy, rr);
                            rg.addColorStop(0, `rgba(240,250,255,${(0.62 * CFG.DY_LIGHT).toFixed(3)})`);
                            rg.addColorStop(0.45, `rgba(200,228,250,${(0.16 * CFG.DY_LIGHT).toFixed(3)})`);
                            rg.addColorStop(1, 'rgba(200,228,250,0)');
                            RL.fillStyle = rg; RL.fillRect(0, 0, rimL.width, rimL.height);
                            const cutY = Math.max(d2ly + 2, HZ * (CFG.DY_RIMBOT ?? 0.62)) * dpr;
                            const mg = RL.createLinearGradient(0, 0, 0, rimL.height);
                            mg.addColorStop(0, 'rgba(0,0,0,1)');
                            mg.addColorStop(clamp(cy / rimL.height, 0, 1), 'rgba(0,0,0,1)');
                            mg.addColorStop(clamp(cutY / rimL.height, 0, 1), 'rgba(0,0,0,0)');
                            RL.globalCompositeOperation = 'destination-in';
                            RL.fillStyle = mg; RL.fillRect(0, 0, rimL.width, rimL.height);
                        }
                        CL.globalCompositeOperation = 'source-atop';
                        CL.setTransform(1, 0, 0, 1, 0, 0);
                        CL.drawImage(rimL, 0, 0);
                        CL.setTransform(dpr, 0, 0, dpr, 0, 0);
                        // 앞턱(음영층): 아래·안쪽에 짙게 깔려 뒷층과 톤이 갈린다
                        CL.globalCompositeOperation = 'source-over';
                        for (const c of set) {
                            if (!isFront(c)) continue;
                            const G = day2Geom(c, base);
                            if (G.dx > W || G.dx + G.tw < 0) continue;
                            CL.drawImage(c.spr, G.dx, G.dy, G.tw, G.th);
                        }
                        // 수평선 쪽 구름 밑동은 한 덩어리의 짙은 청회색 그늘로 가라앉는다 (주로 앞턱이 앉은 하부가 눌린다)
                        CL.globalCompositeOperation = 'source-atop';
                        const bg = CL.createLinearGradient(0, HZ * 0.55, 0, HZ);
                        bg.addColorStop(0, 'rgba(22,36,72,0)');
                        bg.addColorStop(1, 'rgba(22,36,72,0.62)');
                        CL.fillStyle = bg; CL.fillRect(0, HZ * 0.55, W, HZ * 0.45);
                        CL.globalCompositeOperation = 'source-over';
                    } else {
                        for (const c of set) {
                            const G = duskGeom(c, base);
                            if (G.dx > W || G.dx + G.tw < 0) continue;
                            CL.drawImage(c.spr, G.dx, G.dy, G.tw, G.th);
                        }
                    }
                    if (light > 0.005) {
                        // 광원 쪽 구름일수록 더 밝게 반사
                        CL.globalCompositeOperation = 'source-atop';
                        const rg = CL.createRadialGradient(lx, ly, 0, lx, ly, Math.max(W, HZ) * 0.9);
                        rg.addColorStop(0, rgba(hex('#fff2dc'), 0.42 * light));
                        rg.addColorStop(1, 'rgba(255,236,210,0)');
                        CL.fillStyle = rg; CL.fillRect(0, 0, W, HZ);
                        // 하부 음영: 수평선 쪽 구름 밑면을 자주빛으로 가라앉힌다
                        const bg = CL.createLinearGradient(0, HZ * 0.62, 0, HZ);
                        bg.addColorStop(0, 'rgba(94,56,84,0)');
                        bg.addColorStop(1, `rgba(94,56,84,${(0.5 * light).toFixed(3)})`);
                        CL.fillStyle = bg; CL.fillRect(0, HZ * 0.62, W, HZ * 0.38);
                    }
                    const [tc, ta] = keyed(tint, q);
                    if (ta > 0.01) {
                        CL.globalCompositeOperation = 'source-atop';
                        CL.fillStyle = rgba(tc, ta);
                        CL.fillRect(0, 0, W, HZ);
                    }
                    CL.globalCompositeOperation = 'source-over';
                    S.setTransform(1, 0, 0, 1, 0, 0);
                    S.globalAlpha = alpha;
                    S.drawImage(cloudLayer, 0, 0);
                    S.globalAlpha = 1;
                    S.setTransform(dpr, 0, 0, dpr, 0, 0);
                };
                const ca = (1 - ss(CFG.CLOUD_F0, CFG.CLOUD_F1, q)) * (sunVis - w2);
                if (ca > 0.01) drawSet(clouds, CLOUD_TINT, ca, 0);
                if (d2Live > 0.01) drawSet(docOn('day') ? docCloud.day : day2Clouds, DAY2_TINT, d2Live, 0);
                // 브러시 문서는 에디터에서 본 색 그대로 쓰므로 광원 반사·하부 음영(light)을 더하지 않는다
                if (dLive > 0.01) {
                    if (docOn('dusk')) drawSet(docCloud.dusk, DCLOUD_TINT, dLive, 0);
                    else drawSet(duskClouds, DCLOUD_TINT, dLive, 1 - ss(DUSK_Q, CFG.DC_F1, q));
                }

                // 새 낮: 틈 아래 수평선 발광 — 낮은 구름 띠 너머로 빛이 고여 밝은 수평 스트릭이 진다 (수면 미러에도 그대로 비침)
                if (d2Live > 0.01) {
                    S.save();
                    S.translate(d2lx, HZ);
                    S.scale(1, 0.05);
                    const hr = W * 0.22;
                    const hg = S.createRadialGradient(0, 0, 0, 0, 0, hr);
                    hg.addColorStop(0, rgba(hex('#e8f6ff'), Math.min(1, 0.7 * d2Live)));
                    hg.addColorStop(0.4, rgba(hex('#9fd3f2'), 0.32 * d2Live));
                    hg.addColorStop(1, 'rgba(120,180,230,0)');
                    S.fillStyle = hg;
                    S.fillRect(-hr, -hr, hr * 2, hr * 2);
                    S.restore();
                }

                drawStars();

                // mirrorball moon (생성기 기본값 볼 + 클릭 발사 줄눈 빛줄기)
                const m = ss(CFG.MOON_A0, CFG.MOON_A1, q);
                if (m > 0.001) {
                    const mt = 1 - Math.pow(1 - m, 3);
                    // 달은 토리이와 항상 같은 수직선상: x는 effToriiX() 공유, y만 MOON_Y로 조절
                    const mx = W * effToriiX();
                    const my = lerp(HZ + moonR * 2.2, HZ * CFG.MOON_Y, mt);
                    drawMoon(mx, my, moonR, m);
                } else { mbMV = 0; }

                // horizon haze
                const hl = mix(hor, [255, 255, 255], CFG.HAZE_MIX);
                const hg = S.createLinearGradient(0, HZ * 0.86, 0, HZ);
                hg.addColorStop(0, rgba(hl, 0)); hg.addColorStop(1, rgba(hl, CFG.HAZE_A));
                S.fillStyle = hg; S.fillRect(0, HZ * 0.86, W, HZ * 0.14);

                // 미러볼 전환 연출 스포트라이트 (수평선에서 발사)
                drawShow();

                // distant ranges on the horizon (MTN_SHOW=0이면 숨김, 더미로 보존)
                if (CFG.MTN_SHOW >= 0.5) {
                    const mh = clamp(H * CFG.MTN_H, CFG.MTN_MIN, CFG.MTN_MAX);
                    const mc = keyed(MOUNT, q)[0];
                    S.fillStyle = rgba(w2 > 0 ? mix(mc, keyed(MOUNT_DAY2, q)[0], w2) : mc);
                    S.beginPath();
                    S.moveTo(0, HZ);
                    for (let i = 0; i < mtn.length; i++) S.lineTo((i / (mtn.length - 1)) * W, HZ - mtn[i] * mh);
                    S.lineTo(W, HZ);
                    S.closePath();
                    S.fill();
                }

                // 영상 문서 좌우 레터박스: ba-5s-dusk.json(480×160, 실사 214px 중앙) 전용.
                // 문서 pillar는 투명이라 하늘이 비쳐 프레임 경계가 잘린 듯 보이므로, 실사 바깥을 검정 바로 덮는다.
                // S(하늘 캔버스)에 그려 수면 반사에도 그대로 미러되고, 토리이(FG 레이어)보다 아래에 깔린다.
                // 밤이 되어 구름이 사라지면 바도 함께 사라진다(videoBars 내부 dLive 게이트).
                // 같은 범위를 랜턴 컬링(drawLanterns/drawFarLanterns)도 공유한다.
                const vb = videoBars();
                if (vb) {
                    S.fillStyle = '#000';
                    S.fillRect(0, 0, vb[0], HZ);
                    S.fillRect(vb[1], 0, W - vb[1], HZ);
                }
            }

            // 황혼 영상 문서(480×160)의 실사 구간 화면 좌표. 문서가 바뀌면 VB_X 상수도 함께 갱신 필요.
            // ba-5s-dusk.json: 214px 실사를 480폭 중앙에 배치 → u 133/480 ~ 347/480.
            const VB_X0 = 133 / 480, VB_X1 = 347 / 480;
            function videoBars() {
                if (!(CFG.CLOUD_DOC >= 0.5)) return null;
                const D = docCloud.dusk;
                if (!D || !D.doc || !D.spr || D.doc.w !== 480 || D.doc.h !== 160) return null;
                // 구름이 페이드아웃되면 바도 없다 (랜턴 컬링과 공유하는 단일 진실 공급원)
                const live = (1 - sunVis) * (1 - ss(CFG.DC_F0, CFG.DC_F1, palQ()));
                if (live <= 0.01) return null;
                const A = D.doc.w / D.doc.h;
                const f = window.CloudDoc.fit(D.doc, W, HZ);
                const x0 = f.ox + VB_X0 * A * f.k, x1 = f.ox + VB_X1 * A * f.k;
                if (x1 <= 0 || x0 >= W || x1 - x0 <= 0) return null;
                return [Math.max(0, x0), Math.min(W, x1)];
            }

            // ---------- reflection adaptive step ----------
            // ROW_STEP=최소 간격(화질 하한), REFL_MAX_STEP=상한. 부하 시 상한까지 자동 증가.
            // 해상도 하한도 함께 적용: 키가 큰 화면에서도 반사 row 수가 ~220개를 넘지 않게.
            // 랜턴 스프라이트는 이 값과 별도로 2px 상한 (좁은 수직선 비틀림 방지).
            function effReflStep(reflHPx) {
                const base = Math.max(1, Math.round(CFG.ROW_STEP));
                if (reflLastBase !== base) { reflLastBase = base; reflStep = base; }
                const maxS = clamp(Math.round(CFG.REFL_MAX_STEP ?? 6), base, 8);
                reflStep = clamp(reflStep, base, maxS);
                const resFloor = Math.max(1, Math.ceil((reflHPx || 1) / 220));
                return Math.max(reflStep, resFloor);
            }
            function tickReflGovernor(costMs) {
                reflEMA = reflEMA * 0.92 + costMs * 0.08;
                reflCool++;
                if (!(CFG.REFL_AUTO ?? 1)) { reflCool = 0; return; }
                if (reflCool < 90) return;
                reflCool = 0;
                const base = Math.max(1, Math.round(CFG.ROW_STEP));
                const maxS = clamp(Math.round(CFG.REFL_MAX_STEP ?? 6), base, 8);
                if (reflEMA > 19 && reflStep < maxS) reflStep++;
                else if (reflEMA < 11 && reflStep > base) reflStep--;
            }

            // torii standing on the flat in front of the ranges, with its own mirror image
            // torC(본체)/torR(뒤집힌 반사체)은 색·크기가 바뀔 때만 재래스터 (idle 시 60fps 재빌드 제거)
            // 토리이는 항상 불투명(a=1)으로 그린다. 낮 숨김은 호출부의 structA 게이트로만 처리해
            // 페이드 중 반투명 토리이 뒤로 랜턴이 비치는 부자연스러움을 없앤다.
            function drawTorii(r0, r1, a = 1) {
                if (a <= 0.01) return;
                // torii.svg 기준 2색 (red/blk). TORII 팔레트 3번째 gold 값은 레거시 호환용으로 유지하되 그리지 않는다.
                let [red, blk] = keyed(TORII, palQ());
                const w2 = day2W();
                if (w2 > 0) {
                    const [r2, b2] = keyed(TORII_DAY2, palQ());
                    red = mix(red, r2, w2); blk = mix(blk, b2, w2);
                }
                const k = torS * dpr;
                const key = torC.width + 'x' + torC.height + '|' + k.toFixed(3) + '|' +
                    (red[0] | 0) + ',' + (red[1] | 0) + ',' + (red[2] | 0) + '|' +
                    (blk[0] | 0) + ',' + (blk[1] | 0) + ',' + (blk[2] | 0);
                if (key !== torKey) {
                    torKey = key; torRKey = ''; torBuilds++;
                    TC.setTransform(1, 0, 0, 1, 0, 0);
                    TC.clearRect(0, 0, torC.width, torC.height);
                    TC.setTransform(k, 0, 0, k, -TB.x * k, -TB.y * k);
                    TC.fillStyle = rgba(red); TC.fill(TORII_RED);
                    TC.fillStyle = rgba(blk); TC.fill(TORII_BLK);
                }

                // flipped copy, dimmed the same way as the rest of the reflection
                const reflH = H - HZ;
                const rd = lerp(r0, r1, clamp((torBase - HZ) / reflH + 0.15, 0, 1));
                const rkey = torR.width + 'x' + torR.height + '|' + rd.toFixed(3) + '|' + torKey;
                if (rkey !== torRKey) {
                    torRKey = rkey;
                    TR.setTransform(1, 0, 0, 1, 0, 0);
                    TR.globalCompositeOperation = 'source-over';
                    TR.clearRect(0, 0, torR.width, torR.height);
                    TR.setTransform(1, 0, 0, -1, 0, torR.height);
                    TR.drawImage(torC, 0, 0);
                    TR.setTransform(1, 0, 0, 1, 0, 0);
                    TR.globalCompositeOperation = 'source-atop';
                    TR.fillStyle = `rgba(10,18,32,${rd})`;
                    TR.fillRect(0, 0, torR.width, torR.height);
                    TR.globalCompositeOperation = 'source-over';
                }

                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.globalAlpha = a;
                // row r of the flipped copy lands at torBase + r - pad, where pad is the
                // strip of empty sprite below the feet
                const pad = (TB.y + TB.h - TB.base) * torS;
                const top = torBase - pad;
                if (RM.matches) {
                    ctx.drawImage(torR, torX, top, torW, torH);
                } else {
                    const step = effReflStep(H - HZ);
                    for (let r = 0; r < torH; r += step) {
                        const sh = Math.min(step, torH - r);
                        const y = top + r;
                        if (y > H) break;
                        const d = y - HZ, kk = d / reflH;
                        const amp = CFG.REFL_AMP0 + CFG.REFL_AMP1 * kk * kk;
                        const dx = amp * (0.7 * Math.sin(d * CFG.SL_F0 + clock * CFG.SL_F1) + 0.3 * Math.sin(d * CFG.SL_F2 - clock * CFG.SL_F3));
                        ctx.drawImage(torR, 0, r * dpr, torR.width, sh * dpr, torX + dx, y, torW, sh + 0.5);
                    }
                }
                ctx.globalAlpha = 1;
                FG.setTransform(dpr, 0, 0, dpr, 0, 0);
                FG.globalAlpha = a;
                FG.drawImage(torC, torX, torY, torW, torH);
                FG.globalAlpha = 1;
            }

            // lantern-front.svg sprites scattered on the flat, all facing the viewer.
            // Reflections ride on the scene canvas with the same ripple as the torii;
            // bodies + night glow ride on FG above the ripple copy.
            // 낮 시간대에는 숨김: duskW(낮=0, 황혼/밤=1)를 불투명도로 써서 toDay에서 페이드아웃, day idle에서 스킵
            // pass: 'back' = 발이 토리이 발(torBase)보다 위(=더 멀리), 'front' = 그 외.
            // 렌더 순서 back → 토리이 → front 로 뒤 랜턴이 토리이 앞에 그려지지 않게 한다.
            function drawLanterns(r0, r1, a = 1, pass = 'all') {
                if (!lanReady || !lanterns.length || !lanCW) return;
                if (a <= 0.01) return;
                const vb = videoBars();
                // 레터박스 밖으로 몸통 전체가 넘어간 랜턴은 그리지 않는다 (반사·글로우·바닥 빛 포함 통째로 스킵)
                const outVB = L => vb && (L.x + L.w / 2 < vb[0] || L.x - L.w / 2 > vb[1]);
                const inPass = pass === 'all' ? () => true
                    : pass === 'back' ? L => L.y <= torBase : L => L.y > torBase;
                const reflH = Math.max(1, H - HZ);
                const night = lanGlowW();   // 황혼부터 글로우
                const sw = lanCW, shFull = lanCH;
                const shBody = lanBodyH || shFull * LAN_FEET;
                // 랜턴 몸통이 좁아 ROW_STEP이 크면 행 경계마다
                // 수평 오프셋이 점프해 비틀려 보이므로 2px로 고정 + 중앙 샘플링.
                const step = Math.max(1, Math.min(effReflStep(reflH), 2));

                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                // reflections, far-to-near
                for (const L of lanterns) {
                    if (L.w < 2 || L.h < 3 || !inPass(L) || outVB(L)) continue;
                    if (L.x + L.w / 2 < -20 || L.x - L.w / 2 > W + 20) continue;
                    if (L.y < HZ - 2) continue;
                    const dh = Math.min(L.h * LAN_FEET, H - L.y);
                    if (dh < 2) continue;
                    const rd = lerp(r0, r1, clamp((L.y - HZ) / reflH + 0.15, 0, 1));
                    if (RM.matches) {
                        ctx.save();
                        ctx.globalAlpha = (1 - rd) * 0.9 * a;
                        ctx.translate(0, 2 * L.y);
                        ctx.scale(1, -1);
                        ctx.drawImage(lanC, 0, 0, sw, shBody, L.x - L.w / 2, L.y - dh, L.w, dh);
                        ctx.restore();
                    } else {
                        ctx.globalAlpha = (1 - rd) * 0.9 * a;
                        for (let r = 0; r < dh; r += step) {
                            const shD = Math.min(step, dh - r);
                            const y = L.y + r;
                            if (y > H) break;
                            const dc = y + shD / 2 - HZ, kk = dc / reflH;
                            const amp = CFG.REFL_AMP0 + CFG.REFL_AMP1 * kk * kk;
                            const dx = amp * (0.7 * Math.sin(dc * CFG.SL_F0 + clock * CFG.SL_F1) + 0.3 * Math.sin(dc * CFG.SL_F2 - clock * CFG.SL_F3));
                            const srcH = shD / dh * shBody;
                            const srcY = shBody - (r + shD) / dh * shBody;
                            if (srcY < 0 || srcH <= 0) continue;
                            ctx.drawImage(lanC, 0, srcY, sw, srcH, L.x - L.w / 2 + dx, y, L.w, shD + 0.5);
                        }
                        ctx.globalAlpha = 1;
                    }
                }
                ctx.globalAlpha = 1;

                // bodies + night glow, far-to-near
                FG.setTransform(dpr, 0, 0, dpr, 0, 0);
                FG.globalCompositeOperation = 'source-over';
                FG.globalAlpha = a;
                for (const L of lanterns) {
                    if (L.w < 2 || L.h < 3 || !inPass(L) || outVB(L)) continue;
                    if (L.x + L.w / 2 < -L.w || L.x - L.w / 2 > W + L.w) continue;
                    const top = L.y - L.h * LAN_FEET;
                    FG.drawImage(lanC, L.x - L.w / 2, top, L.w, L.h);
                    if (night > 0.01) {
                        const gx = L.x, gy = L.y - L.h * 0.52;
                        FG.globalCompositeOperation = 'lighter';
                        // halo behind the glass: 먼(수평선 쪽) 랜턴일수록 반경을 키워 더 번져 보이게
                        const farK = 1 - clamp(L.sn, 0, 1);
                        const hr = L.h * (0.6 + Math.max(0, CFG.LANTERN_HALO ?? 1) * 1.4 * farK * farK);
                        if (hr > 1) {
                            const ha = 0.6 * night * CFG.LANTERN_GLOW;
                            const hg = FG.createRadialGradient(gx, gy, 0, gx, gy, hr);
                            hg.addColorStop(0, `rgba(255,196,118,${ha})`);
                            hg.addColorStop(0.35, `rgba(255,178,96,${ha * 0.45})`);
                            hg.addColorStop(1, 'rgba(255,170,90,0)');
                            FG.fillStyle = hg;
                            FG.beginPath(); FG.arc(gx, gy, hr, 0, Math.PI * 2); FG.fill();
                        }
                        // lit glass
                        FG.fillStyle = `rgba(255,224,160,${0.28 * night * CFG.LANTERN_GLOW})`;
                        FG.fillRect(gx - L.w * 0.14, top + L.h * 0.157, L.w * 0.28, L.h * 0.667);
                        // warm pool on the floor
                        const pa = 0.35 * night * CFG.LANTERN_POOL;
                        if (pa > 0.005) {
                            FG.save();
                            FG.translate(gx, L.y + L.h * 0.02);
                            FG.scale(1, 0.25);
                            const pr = L.w * 0.95;
                            const pg = FG.createRadialGradient(0, 0, 0, 0, 0, pr);
                            pg.addColorStop(0, `rgba(255,174,64,${pa})`);
                            pg.addColorStop(1, 'rgba(255,138,26,0)');
                            FG.fillStyle = pg;
                            FG.beginPath(); FG.arc(0, 0, pr, 0, Math.PI * 2); FG.fill();
                            FG.restore();
                        }
                        FG.globalCompositeOperation = 'source-over';
                    }
                }
                FG.globalAlpha = 1;
            }

            // ---------- 구름 블룸 ----------
            // 방금 cloudLayer에 그린 구름 세트만 원천으로 쓴다(하늘·달·별은 번지지 않는다). drawSet 직후 S(하늘)에 screen으로 얹으므로
            // 수면 반사(하늘 미러)에도 그대로 비친다. ctx.filter가 있으면 blur, 없으면(구형 Safari) 축소 피라미드 자체를 흐림으로 쓴다.
            function fitCanvas(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
            function drawBloom(alpha) {
                const cw = cloudLayer.width, ch = cloudLayer.height;
                if (!cw || !ch) return;
                const w4 = Math.max(1, Math.round(cw / 4)), h4 = Math.max(1, Math.round(ch / 4));
                fitCanvas(bloomA, w4, h4); fitCanvas(bloomB, w4, h4);
                // 1) 밝은 부분: 검정 위에 구름(프리멀티플라이드라 알파가 곧 밝기에 반영) → 자기 자신과 곱해 x^POW (색상 유지)
                BA.setTransform(1, 0, 0, 1, 0, 0);
                BA.globalCompositeOperation = 'source-over'; BA.globalAlpha = 1; BA.filter = 'none';
                BA.fillStyle = '#000'; BA.fillRect(0, 0, w4, h4);
                BA.imageSmoothingEnabled = true; BA.imageSmoothingQuality = 'medium';
                BA.drawImage(cloudLayer, 0, 0, w4, h4);
                const sq = clamp(Math.round(Math.log2(Math.max(1, CFG.BLOOM_POW))), 0, 4);
                for (let i = 0; i < sq; i++) {
                    BB.globalCompositeOperation = 'copy'; BB.filter = 'none'; BB.drawImage(bloomA, 0, 0);
                    BA.globalCompositeOperation = 'multiply'; BA.drawImage(bloomB, 0, 0);
                }
                BA.globalCompositeOperation = 'source-over';
                // 2) 축소 피라미드 1/8 → 1/16 → 1/32 (반씩 줄이면 쌍선형 필터가 쌓여 그 자체로 흐림이 된다)
                let src = bloomA, sw = w4, sh = h4;
                for (const P of bloomP) {
                    sw = Math.max(1, sw >> 1); sh = Math.max(1, sh >> 1);
                    fitCanvas(P.c, sw, sh);
                    P.g.globalCompositeOperation = 'copy'; P.g.filter = 'none';
                    P.g.imageSmoothingEnabled = true; P.g.imageSmoothingQuality = 'medium';
                    P.g.drawImage(src, 0, 0, sw, sh);
                    src = P.c;
                }
                // 3) 가까운 번짐(near) + 넓은 후광(wide)
                let near = bloomP[0].c, wide = bloomP[2].c;
                if (FILTER_OK) {
                    const r = Math.max(0.5, CFG.BLOOM_R * ch / 4);
                    BB.globalCompositeOperation = 'copy'; BB.filter = `blur(${r.toFixed(2)}px)`;
                    BB.drawImage(bloomA, 0, 0); BB.filter = 'none';
                    near = bloomB;
                    const P = bloomP[1];   // 1/16에서 넓게: 같은 비용으로 반경 4배
                    P.g.globalCompositeOperation = 'copy'; P.g.filter = `blur(${(r * 0.75).toFixed(2)}px)`;
                    P.g.drawImage(P.c, 0, 0); P.g.filter = 'none';
                    wide = P.c;
                }
                S.save();
                S.setTransform(1, 0, 0, 1, 0, 0);
                S.globalCompositeOperation = 'screen';
                S.imageSmoothingEnabled = true; S.imageSmoothingQuality = 'high';
                const k = CFG.BLOOM * alpha;
                // screen은 1을 넘지 못하므로 세기 > 1이면 한 번 더 얹는다
                for (let a = k; a > 0.003; a -= 1) {
                    S.globalAlpha = Math.min(1, a);
                    S.drawImage(near, 0, 0, cw, ch);
                    S.globalAlpha = Math.min(1, a) * CFG.BLOOM_WIDE;
                    S.drawImage(wide, 0, 0, cw, ch);
                }
                S.restore();
            }

            function render() {
                drawSky();

                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = 1;
                ctx.drawImage(sky, 0, 0);

                // mirrored salt-flat reflection, sliced into rows for faint ripples
                const reflH = H - HZ;
                if (RM.matches) {
                    ctx.setTransform(dpr, 0, 0, -dpr, 0, (HZ * 2) * dpr);
                    ctx.drawImage(sky, 0, Math.max(0, HZ - reflH) * dpr, sky.width, Math.min(HZ, reflH) * dpr,
                        0, HZ - Math.min(HZ, reflH), W, Math.min(HZ, reflH));
                } else {
                    const step = effReflStep(reflH);
                    const scale = clamp(Number(CFG.REFL_SCALE ?? 0.5) || 0.5, 0.25, 1);
                    if (scale < 0.99 && reflH > 0) {
                        // downscale path: 작은 버퍼에 row-slice 후 1회 업스케일 합성
                        const rw = Math.max(1, Math.round(cv.width * scale));
                        const rh = Math.max(1, Math.round((cv.height - floorTop) * scale));
                        if (reflC.width !== rw || reflC.height !== rh) { reflC.width = rw; reflC.height = rh; }
                        RC.setTransform(1, 0, 0, 1, 0, 0);
                        RC.globalCompositeOperation = 'source-over';
                        RC.globalAlpha = 1;
                        RC.clearRect(0, 0, rw, rh);
                        const k2 = dpr * scale;
                        for (let d = 0; d < reflH; d += step) {
                            const sh = Math.min(step, reflH - d);
                            const srcY = HZ - d - sh;
                            if (srcY < 0) break;
                            const k = d / reflH;
                            const amp = CFG.REFL_AMP0 + CFG.REFL_AMP1 * k * k;
                            const dx = amp * (0.7 * Math.sin(d * CFG.SL_F0 + clock * CFG.SL_F1) + 0.3 * Math.sin(d * CFG.SL_F2 - clock * CFG.SL_F3));
                            RC.setTransform(k2, 0, 0, -k2, dx * k2, (d + sh) * k2);
                            RC.drawImage(sky, 0, srcY * dpr, sky.width, sh * dpr, -3, -0.5, W + 6, sh + 0.5);
                        }
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.globalCompositeOperation = 'source-over';
                        ctx.globalAlpha = 1;
                        ctx.imageSmoothingEnabled = true;
                        ctx.drawImage(reflC, 0, 0, rw, rh, 0, floorTop, cv.width, cv.height - floorTop);
                    } else {
                    for (let d = 0; d < reflH; d += step) {
                        const sh = Math.min(step, reflH - d);
                        const srcY = HZ - d - sh;
                        if (srcY < 0) break;
                        const k = d / reflH;
                        const amp = CFG.REFL_AMP0 + CFG.REFL_AMP1 * k * k;
                        const dx = amp * (0.7 * Math.sin(d * CFG.SL_F0 + clock * CFG.SL_F1) + 0.3 * Math.sin(d * CFG.SL_F2 - clock * CFG.SL_F3));
                        ctx.setTransform(dpr, 0, 0, -dpr, dx * dpr, (HZ + d + sh) * dpr);
                        ctx.drawImage(sky, 0, srcY * dpr, sky.width, sh * dpr, -3, -0.5, W + 6, sh + 0.5);
                    }
                    }
                }

                // soften the reflection near the horizon; the real ranges above stay sharp
                // because only rows from the horizon downward are pasted back.
                // blur+복사는 BAND_EVERY 프레임마다만 갱신 (사이 프레임은 캐시 blit만).
                if (bandH > 0) {
                    const every = Math.max(1, Math.round(CFG.BAND_EVERY ?? 3));
                    const qNow = palQ();
                    const pMoved = Math.abs(qNow - bandLastP) > 0.004;
                    if (!bandValid || (bandTick % every) === 0 || pMoved) {
                        bandBuilds++;
                        bandLastP = qNow;
                        const srcY = (HZ - CFG.BAND_PAD) * dpr, srcH = (bandH + CFG.BAND_PAD * 2) * dpr;
                        BD.setTransform(1, 0, 0, 1, 0, 0);
                        BD.globalCompositeOperation = 'source-over';
                        BD.clearRect(0, 0, band.width, band.height);
                        if (FILTER_OK) BD.filter = `blur(${(CFG.BLUR_PX * dpr / BAND_SCALE).toFixed(2)}px)`;
                        BD.drawImage(cv, 0, srcY, cv.width, srcH, 0, 0, band.width, band.height);
                        BD.filter = 'none';
                        const y0 = CFG.BAND_PAD * dpr / BAND_SCALE, y1 = (CFG.BAND_PAD + bandH) * dpr / BAND_SCALE;
                        const mg = BD.createLinearGradient(0, y0, 0, y1);
                        mg.addColorStop(0, 'rgba(0,0,0,1)');
                        mg.addColorStop(0.35, 'rgba(0,0,0,0.6)');
                        mg.addColorStop(1, 'rgba(0,0,0,0)');
                        BD.globalCompositeOperation = 'destination-in';
                        BD.fillStyle = mg;
                        BD.fillRect(0, 0, band.width, band.height);
                        BD.globalCompositeOperation = 'source-over';
                        bandValid = true;
                    }
                    bandTick++;
                    const y0 = CFG.BAND_PAD * dpr / BAND_SCALE, y1 = (CFG.BAND_PAD + bandH) * dpr / BAND_SCALE;
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.drawImage(band, 0, y0, band.width, y1 - y0, 0, HZ * dpr, cv.width, bandH * dpr);
                }

                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                const qR = palQ();
                const w2 = day2W();
                let [r0, r1] = keyed(REFL, qR);
                if (w2 > 0) { const [a, b] = keyed(REFL_DAY2, qR); r0 = lerp(r0, a, w2); r1 = lerp(r1, b, w2); }
                const rg = ctx.createLinearGradient(0, HZ, 0, H);
                rg.addColorStop(0, `rgba(10,18,32,${r0})`);
                rg.addColorStop(1, `rgba(10,18,32,${r1})`);
                ctx.fillStyle = rg; ctx.fillRect(0, HZ, W, H - HZ);
                // 새 낮: 수면이 하늘보다 짙은 바다빛 청색 (수평선 쪽은 옅게)
                const wa = (CFG.DY_WATER ?? 0) * w2 * (1 - ss(CFG.DY_F0, CFG.DY_F1, qR));
                if (wa > 0.005) {
                    const wg = ctx.createLinearGradient(0, HZ, 0, H);
                    wg.addColorStop(0, `rgba(28,92,156,${(wa * 0.55).toFixed(3)})`);
                    wg.addColorStop(1, `rgba(18,70,134,${wa.toFixed(3)})`);
                    ctx.fillStyle = wg; ctx.fillRect(0, HZ, W, H - HZ);
                }
                if (w2 > 0.01) drawGlints(w2, qR);
                // 새 낮: 틈 빛의 수면 기둥 — 수평선에서 아래로 퍼지는 청백색 반사. 수평선에 밝고 아래로 갈수록 옅어진다
                const colA = (CFG.DY_COLUMN ?? 0) * w2 * (1 - ss(CFG.DY_F0, CFG.DY_F1, qR));
                if (colA > 0.01) {
                    const cx = W * CFG.DY_LX, rw = W * 0.055;
                    ctx.save();
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.translate(cx, HZ);
                    ctx.scale(1, (H - HZ) / rw);
                    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, rw);
                    cg.addColorStop(0, `rgba(206,236,252,${Math.min(1, 0.5 * colA).toFixed(3)})`);
                    cg.addColorStop(0.45, `rgba(150,204,240,${(0.14 * colA).toFixed(3)})`);
                    cg.addColorStop(1, 'rgba(120,180,230,0)');
                    ctx.fillStyle = cg;
                    // 수면 아래만: 위쪽(하늘·하부 구름·수평선)은 건드리지 않는다
                    ctx.fillRect(-rw, 0, rw * 2, rw);
                    ctx.restore();
                }

                // seam glow where sky meets its mirror
                const hor = skyAt(qR)[SKY_STOPS.length - 1];
                const hl = mix(hor, [255, 255, 255], 0.3);
                const sg = ctx.createLinearGradient(0, HZ - 6, 0, HZ + 14);
                sg.addColorStop(0, rgba(hl, 0)); sg.addColorStop(0.3, rgba(hl, CFG.SEAM_A)); sg.addColorStop(1, rgba(hl, 0));
                ctx.fillStyle = sg; ctx.fillRect(0, HZ - 6, W, 20);

                FG.setTransform(1, 0, 0, 1, 0, 0);
                FG.clearRect(0, 0, fg.width, fg.height);
                // 낮에는 토리이/랜턴 숨김: duskW(낮=0, 황혼/밤=1)로 페이드. toDay에서 사라지고 toNight에서 복원된다
                // 단 토리이는 항상 불투명으로: 반투명 상태에서 뒤 랜턴이 비치지 않게 structA 대신 1을 넘긴다.
                const structA = clamp(duskW, 0, 1);
                if (structA > 0.01) {
                    // 깊이 순서: 수평선 경량 랜턴 → 토리이 뒤 랜턴 → 토리이 → 토리이 앞 랜턴
                    drawFarLanterns(structA, lanGlowW());
                    drawLanterns(r0, r1, structA, 'back');
                    drawTorii(r0, r1, 1);
                    drawLanterns(r0, r1, structA, 'front');
                }
                FG.setTransform(dpr, 0, 0, dpr, 0, 0);

                const v = lerp(keyed(VIG, qR)[0], keyed(VIG_DAY2, qR)[0], w2);
                const vg = FG.createRadialGradient(W / 2, HZ, Math.min(W, H) * 0.35, W / 2, HZ, Math.hypot(W, H) * 0.72);
                vg.addColorStop(0, 'rgba(0,0,0,0)');
                vg.addColorStop(1, `rgba(0,0,0,${v})`);
                FG.fillStyle = vg; FG.fillRect(0, 0, W, H);
            }

            // ---------- click ripples on the flat (WebGL) ----------
            // The 2D canvas keeps drawing the scene. While a ripple is alive, the floor rows
            // are copied into a texture and redrawn through a shader on #ripple, which sits
            // between the scene and the foreground layer. Ripples are modelled on the ground
            // plane, so rings flatten and shrink toward the horizon. Each ring is capped at
            // RIP_MAX_R: its amplitude has faded to zero by then and it is removed.
            const glc = document.getElementById('ripple');
            const floorC = document.createElement('canvas');
            const FL = floorC.getContext('2d');
            const RIP_SLOTS = 8;    // 셰이더 슬롯 고정값 (CFG.RIP_MAX는 1..RIP_SLOTS 범위에서 동작)
            const ripples = [];
            const ripU = new Float32Array(RIP_SLOTS * 4);
            let gl = null, glU = null, glTex = null, glOn = false;
            let floorTop = 0, floorH = 1, texW = 0, texH = 0;

            const RIP_VS = 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}';
            const RIP_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec2 uRes;       // floor size, device px
uniform float uDpr;
uniform float uCx;       // horizontal centre, css px
uniform float uF;        // focal length, css px
uniform float uStr;
uniform float uK;
uniform int uN;
uniform vec4 uRip[${RIP_SLOTS}];   // ground x, ground z, ring radius, amplitude
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = fc / uDpr;                       // css px; p.y = depth below the horizon
  float s = max(p.y, 0.5);
  float gz = uF / s;                        // fore-aft position on the ground plane
  vec2 slope = vec2(0.0);
  vec2 off = vec2(0.0);
  float glint = 0.0;
  for (int i = 0; i < ${RIP_SLOTS}; i++) {
    if (i >= uN) break;
    vec4 r = uRip[i];
    // NOTE: x는 클릭 깊이(s0) 기준으로 정규화한다. 기존처럼 현재 픽셀 깊이(s)로
    // 나누면 중심이 화면 중앙-클릭점을 잇는 사선 위를 움직여 중앙 외 클릭에서
    // 파문이 사선으로 기울어진다. s0 기준이면 중심이 항상 x=cx 수직선 위에 있어
    // 파문이 항상 수평(가로 타원)을 유지한다. y(앞뒤) 원근 압축은 그대로 둔다.
    float s0 = uF / max(r.y, 1e-3);         // clicked depth, css px
    vec2 d = vec2((p.x - uCx) / s0 - r.x, gz - r.y);
    if (max(abs(d.x), abs(d.y)) > 1.5) continue;
    float dist = length(d);
    vec2 dir = d / max(dist, 1e-4);
    float e = dist - r.z;                   // > 0 ahead of the ring, < 0 behind it
    float w = e > 0.0 ? 0.02 : 0.1;         // sharp front, a few trailing crests
    // crest spacing on screen; fade where it would alias (thin rings near the horizon)
    float px = 6.2832 / uK / length(vec2(dir.x / s0, dir.y * uF / (s * s)));
    float env = exp(-(e * e) / (w * w)) * r.w * smoothstep(2.0, 5.0, px) * smoothstep(0.0, 0.03, dist);
    float c = cos(uK * e) * env;
    slope += c * dir;
    off += c * vec2(dir.x * s0, -dir.y * s * s / uF);
    glint += max(0.0, sin(uK * e)) * env;
  }
  vec2 o = off * uStr;
  vec2 uv = (fc + o * uDpr) / uRes;
  uv.y = max(uv.y, 0.5 / uRes.y);
  vec3 col = texture2D(uTex, uv).rgb;
  float shade = clamp(slope.y, -1.0, 1.0);  // tilt toward / away from the viewer
  col *= 1.0 + 0.16 * shade;
  glint = min(glint, 1.0);
  col += glint * (0.08 * vec3(0.8, 0.86, 1.0) + 0.12 * col);   // faint crest highlight, visible at night too
  gl_FragColor = vec4(col, 1.0);
}`;

            function initGL() {
                gl = null;
                let g = null;
                try {
                    g = glc.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
                } catch (e) { g = null; }
                if (!g) return;
                try {
                    const sh = (type, src) => {
                        const o = g.createShader(type);
                        g.shaderSource(o, src);
                        g.compileShader(o);
                        if (!g.getShaderParameter(o, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(o));
                        return o;
                    };
                    const prog = g.createProgram();
                    g.attachShader(prog, sh(g.VERTEX_SHADER, RIP_VS));
                    g.attachShader(prog, sh(g.FRAGMENT_SHADER, RIP_FS));
                    g.linkProgram(prog);
                    if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
                    g.useProgram(prog);
                    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
                    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
                    const aPos = g.getAttribLocation(prog, 'aPos');
                    g.enableVertexAttribArray(aPos);
                    g.vertexAttribPointer(aPos, 2, g.FLOAT, false, 0, 0);
                    glTex = g.createTexture();
                    g.activeTexture(g.TEXTURE0);
                    g.bindTexture(g.TEXTURE_2D, glTex);
                    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
                    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
                    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
                    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
                    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
                    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                    glU = {};
                    for (const k of ['uTex', 'uRes', 'uDpr', 'uCx', 'uF', 'uStr', 'uK', 'uN']) glU[k] = g.getUniformLocation(prog, k);
                    glU.uRip = g.getUniformLocation(prog, 'uRip[0]');
                    g.uniform1i(glU.uTex, 0);
                    g.uniform1f(glU.uStr, CFG.RIP_STR);
                    g.uniform1f(glU.uK, CFG.RIP_K);
                    texW = texH = 0;
                    gl = g;
                } catch (e) {
                    console.warn('ripple effect disabled:', e);
                }
            }
            glc.addEventListener('webglcontextlost', e => { e.preventDefault(); gl = null; });
            glc.addEventListener('webglcontextrestored', initGL);

            // the ripple layer covers exactly the device-pixel rows below the horizon
            function resizeRipple() {
                floorTop = Math.round(HZ * dpr);
                floorH = Math.max(1, cv.height - floorTop);
                floorC.width = cv.width; floorC.height = floorH;
                glc.width = cv.width; glc.height = floorH;
                glc.style.top = (floorTop / dpr) + 'px';
                glc.style.height = (floorH / dpr) + 'px';
            }

            // touch drags must reach us as pointermove (no scroll/zoom hijack on the canvases)
            for (const c of [cv, glc, fg]) { try { c.style.touchAction = 'none'; } catch (e) {} }

            function spawnRipple(clientX, clientY) {
                const fh = floorH / dpr;
                const s = clientY - floorTop / dpr;
                if (s < 6 || s > fh) return false;
                if (ripples.length >= Math.min(RIP_SLOTS, Math.max(1, Math.round(CFG.RIP_MAX)))) ripples.shift();
                ripples.push({ xn: clientX / W, sn: s / fh, t: 0 });
                return true;
            }
            // press-and-drag spawns continuously on move (mouse/touch/pen = Pointer Events).
            // press-and-hold without moving spawns only the initial pointerdown ripple:
            // spawns below are move-driven only, never timer-driven.
            const dragPts = new Map();   // pointerId -> { x, y, t } (anchor of last spawned ripple)
            const DRAG_MIN_DIST = 24;    // css px between spawned ripples
            const DRAG_MIN_DT = 0.06;    // seconds between spawned ripples
            const overUI = t => (t instanceof Element) && !!t.closest('.panel,.tsd-panel,#tsdFab,.tsce-pad,.focus-ui');

            window.addEventListener('pointerdown', e => {
                if (!gl || RM.matches || e.button > 0) return;
                if (overUI(e.target)) return;
                if (spawnRipple(e.clientX, e.clientY)) {
                    dragPts.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() / 1000 });
                }
            });
            window.addEventListener('pointermove', e => {
                const st = dragPts.get(e.pointerId);
                if (!st || !gl || RM.matches) return;
                if (overUI(e.target)) { st.x = e.clientX; st.y = e.clientY; return; }
                const fh = floorH / dpr;
                const s = e.clientY - floorTop / dpr;
                if (s < 6 || s > fh) { st.x = e.clientX; st.y = e.clientY; return; }
                const dx = e.clientX - st.x, dy = e.clientY - st.y;
                if (dx * dx + dy * dy < DRAG_MIN_DIST * DRAG_MIN_DIST) return;
                const now = performance.now() / 1000;
                if (now - st.t < DRAG_MIN_DT) return;
                st.x = e.clientX; st.y = e.clientY;
                if (spawnRipple(e.clientX, e.clientY)) st.t = now;
            });
            const endDrag = e => { dragPts.delete(e.pointerId); };
            window.addEventListener('pointerup', endDrag);
            window.addEventListener('pointercancel', endDrag);
            window.addEventListener('blur', () => dragPts.clear());

            // 미러볼(달) 클릭 → 줄눈 빛줄기 발사. 하늘 클릭이라 수면 ripple과 겹치지 않는다.
            window.addEventListener('pointerdown', e => {
                if (e.button > 0 || RM.matches) return;
                if (overUI(e.target)) return;
                if (mbMV < 0.05 || mbMR < 2) return;
                const dx = e.clientX - mbMX, dy = e.clientY - mbMY, rr = mbMR * 1.5;
                if (dx * dx + dy * dy <= rr * rr) mbFire();
            });

            function stepRipples(dt) {
                if (debugPaused) return;
                for (let i = ripples.length - 1; i >= 0; i--) {
                    ripples[i].t += dt;
                    if (CFG.RIP_V * ripples[i].t >= CFG.RIP_MAX_R) ripples.splice(i, 1);
                }
            }

            function drawRipples() {
                const on = gl !== null && ripples.length > 0;
                if (on !== glOn) { glOn = on; glc.style.display = on ? 'block' : 'none'; }
                if (!on) return;
                FL.setTransform(1, 0, 0, 1, 0, 0);
                FL.drawImage(cv, 0, floorTop, cv.width, floorH, 0, 0, floorC.width, floorC.height);
                gl.bindTexture(gl.TEXTURE_2D, glTex);
                if (texW !== floorC.width || texH !== floorC.height) {
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, floorC);
                    texW = floorC.width; texH = floorC.height;
                } else {
                    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, floorC);
                }
                const foc = CFG.FOCAL * H, fh = floorH / dpr;
                ripU.fill(0);
                ripples.forEach((r, i) => {
                    const s = Math.max(1, r.sn * fh);
                    const R = CFG.RIP_V * r.t;
                    // quick attack, steady decay, and a fade that reaches zero at the radius cap
                    const a = ss(0, 0.06, r.t) * Math.exp(-0.8 * r.t) * (1 - ss(0.45 * CFG.RIP_MAX_R, CFG.RIP_MAX_R, R));
                    ripU[i * 4] = (r.xn * W - W / 2) / s;
                    ripU[i * 4 + 1] = foc / s;
                    ripU[i * 4 + 2] = R;
                    ripU[i * 4 + 3] = a;
                });
                gl.viewport(0, 0, glc.width, glc.height);
                gl.uniform2f(glU.uRes, glc.width, glc.height);
                gl.uniform1f(glU.uDpr, dpr);
                gl.uniform1f(glU.uCx, W / 2);
                gl.uniform1f(glU.uF, foc);
                gl.uniform1f(glU.uStr, CFG.RIP_STR);
                gl.uniform1f(glU.uK, CFG.RIP_K);
                gl.uniform1i(glU.uN, ripples.length);
                gl.uniform4fv(glU.uRip, ripU);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }

            // ---------- UI ----------
            let uiKey = '', lastNight = null, lastActive = '';
            // 초기 1회성 황혼→밤 전환이 끝나기 전에는 시간대 전환 UI를 숨긴다.
            // HTML의 .intro-hidden을 첫 안정 상태 진입 시점에 떼고 아래에서 올라오는 애니메이션으로 보여준다.
            let introDone = false;
            function revealIntroPanel() {
                if (introDone || !elPanel) return;
                introDone = true;
                elPanel.classList.remove('intro-hidden');
                // 리플로우 후 애니메이션 클래스를 붙여야 매번 fadeInUp이 재생된다
                void elPanel.offsetWidth;
                elPanel.classList.add('intro-enter');
                elPanel.addEventListener('animationend', () => elPanel.classList.remove('intro-enter'), { once: true });
                moveThumb(false);
            }
            const elThumb = document.getElementById('thumb');
            // 상태가 향하는 목표: 'day' | 'dusk' | 'night'
            const targetOf = s => (s === 'day' || s === 'toDay' ? 'day' : s === 'dusk' || s === 'toDusk' ? 'dusk' : 'night');
            // UI 강조 대상: 밤 + 미러볼이면 'mirror'
            const activeOf = () => { const t = targetOf(state); return t === 'night' && moonTarget === 'mirror' ? 'mirror' : t; };
            // 아이콘 클릭 → 현재 p에서 목표까지 자연스럽게 전환 (전환 중 재클릭도 현재 p에서 다시 시작)
            // 'night' = 밤 + 일반 달, 'mirror' = 밤 + 미러볼 달(일반 달 → 미러볼 전환 연출, 밤이 아니면 밤 도착 후 실행)
            function goTo(target) {
                if (target !== 'day' && target !== 'dusk' && target !== 'night' && target !== 'mirror') return;
                if (target === 'night' || target === 'mirror') {
                    const wantMirror = target === 'mirror';
                    if (wantMirror !== (moonTarget === 'mirror')) {
                        moonTarget = wantMirror ? 'mirror' : 'plain';
                        if (!wantMirror) { mbPending = false; endShow(); }
                        else if (state === 'night' && mbMix < 1) startShow();
                        else if (mbMix < 1) mbPending = true;
                    }
                    target = 'night';
                } else {
                    endShow();
                    // 밤 도착 전에 낮/황혼으로 돌아가면 예약된 연출 취소
                    if (mbPending) { mbPending = false; moonTarget = 'plain'; }
                }
                if (targetOf(state) === target) return;
                transFrom = p;
                nkFrom = nk;
                duskFrom = duskW;
                svFrom = sunVis;
                svTo = target === 'day' ? 1 : target === 'dusk' ? 0 : sunVis;
                transTarget = target;
                if (target === 'night') {
                    // 현재 시각(qFrom)을 낮 분기 좌표로 스냅: q가 같아 화면 점프는 없고,
                    // 이후 정체 없이 하늘이 바로 어두워지며 궤적·별·달이 뒤따른다. 소요시간은 T_NIGHT 그대로.
                    const qFrom = palQ();
                    p = qFrom; transFrom = qFrom;
                    duskW = 0; duskFrom = 0;
                    transTo = 1;
                    state = 'toNight'; tState = 0;
                    nkTo = 1;
                    duskTo = 1;
                    phi = 0; phiTail = null; omega = 0;
                } else {
                    transTo = target === 'day' ? CFG.P_DAY : CFG.P_DUSK;
                    state = target === 'day' ? 'toDay' : 'toDusk'; tState = 0;
                    nkTo = 0;
                    duskTo = target === 'day' ? 0 : 1;
                }
            }
            function updateUI() {
                // 초기 toNight가 끝나고 처음 안정 상태(night/day/dusk)에 닿으면 UI를 올린다.
                // (디버그로 인트로를 중단하고 다른 상태로 점프해도 그 시점에 노출)
                if (!introDone && state !== 'toNight') revealIntroPanel();
                let status;
                const active = activeOf();
                if (state === 'day') status = '낮';
                else if (state === 'dusk') status = '황혼';
                else if (state === 'toNight') status = '밤으로 전환 중';
                else if (state === 'night') status = moonTarget === 'mirror' ? '밤 (미러볼)' : '밤';
                else status = state === 'toDay' ? '낮으로 전환 중' : '황혼으로 전환 중';
                const key = status;
                if (key !== uiKey) {
                    uiKey = key;
                    elStatus.textContent = status;
                }
                // card switches to its night palette once the sky has gone dark
                const night = palQ() >= 0.5;
                if (night !== lastNight) { lastNight = night; elPanel.classList.toggle('is-night', night); }
                if (active !== lastActive) {
                    lastActive = active;
                    for (const [el, m] of [[elDay, 'day'], [elDusk, 'dusk'], [elNight, 'night'], [elMirror, 'mirror']]) {
                        if (!el) continue;
                        const on = active === m;
                        el.classList.toggle('on', on);
                        el.setAttribute('aria-pressed', on ? 'true' : 'false');
                    }
                    moveThumb();
                }
            }

            // 강조 커서(thumb): 현재 시간 아이콘 위로 슬라이드 이동.
            // 평소 1칸 버블(접힘)에서는 x=0, 펼침에서는 인덱스*칸 이동.
            const ORDER = () => [elDay, elDusk, elNight, elMirror];
            const HOVER_OK = (() => { try { return window.matchMedia('(hover: hover)').matches; } catch (e) { return true; } })();
            const TOUCH_UI = (() => { try { return window.matchMedia('(hover: none)').matches; } catch (e) { return false; } })();
            let thumbInit = false;
            function isExpanded() {
                if (!elPanel) return false;
                if (elPanel.classList.contains('expanded')) return true;
                try {
                    if (elPanel.matches(':focus-within')) return true;
                    if (HOVER_OK && elPanel.matches(':hover')) return true;
                } catch (e) { /* matches 미지원 */ }
                return false;
            }
            function moveThumb(animate = true) {
                if (!elThumb || !elPanel) return;
                const btns = ORDER();
                let idx = Math.max(0, btns.findIndex(b => b && b.classList.contains('on')));
                const activeBtn = btns[idx] || btns[2];
                if (!activeBtn) return;
                const fullW = activeBtn.offsetWidth || 46;
                const fullH = activeBtn.offsetHeight || 46;
                // thumb 크기를 버튼에 맞춤 (46px PC / 48px 모바일)
                if (elThumb.style.width !== fullW + 'px') elThumb.style.width = fullW + 'px';
                if (elThumb.style.height !== fullH + 'px') elThumb.style.height = fullH + 'px';
                const gap = 4; // .icongroup gap과 동일
                const x = isExpanded() ? idx * (fullW + gap) : 0;
                if (!thumbInit || !animate) {
                    const prev = elThumb.style.transition;
                    elThumb.style.transition = 'none';
                    elThumb.style.transform = 'translateX(' + x + 'px)';
                    // 강제 리플로우 후 transition 복원
                    void elThumb.offsetWidth;
                    elThumb.style.transition = prev;
                    thumbInit = true;
                } else {
                    elThumb.style.transform = 'translateX(' + x + 'px)';
                }
            }

            // 펼침/접힘에 맞춰 thumb도 함께 이동 (버튼 width 애니메이션과 같은 타이밍)
            if (elPanel) {
                elPanel.addEventListener('mouseenter', () => moveThumb());
                elPanel.addEventListener('mouseleave', () => moveThumb());
                elPanel.addEventListener('focusin', () => moveThumb());
                elPanel.addEventListener('focusout', () => {
                    // 포커스가 패널 밖으로 나갈 때만 접힘으로 간주
                    setTimeout(() => moveThumb(), 0);
                });
                // 레이아웃 변화(반응형 버튼 크기) 시 thumb 재위치. 캔버스 resize와 별개로 가볍게 처리.
                window.addEventListener('resize', () => moveThumb(false));
                // 초기 위치 (애니메이션 없이)
                requestAnimationFrame(() => moveThumb(false));
                setTimeout(() => moveThumb(false), 300);
            }
            // 컨트롤 패널 크기 변화(펼침/접힘, 반응형)를 랜턴 회피 영역에 반영.
            // projectLanterns가 실측하므로 rect가 실제로 바뀔 때만 재투영한다.
            if (elPanel && window.ResizeObserver) {
                let cardROTimer = 0;
                let cardLastRect = '';
                try {
                    const r0 = elPanel.getBoundingClientRect();
                    cardLastRect = [r0.left, r0.top, r0.width, r0.height].join(',');
                } catch (e) { /* 측정 실패 시 첫 콜백에서 처리 */ }
                try {
                    const cardRO = new ResizeObserver(() => {
                        clearTimeout(cardROTimer);
                        cardROTimer = setTimeout(() => {
                            try {
                                const r = elPanel.getBoundingClientRect();
                                const key = [r.left, r.top, r.width, r.height].join(',');
                                if (key === cardLastRect) return;
                                cardLastRect = key;
                                projectLanterns();
                            } catch (e) { /* 측정 실패 시 현상 유지 */ }
                        }, 200);
                    });
                    cardRO.observe(elPanel);
                } catch (e) { /* observer 미지원 시 resize 때만 반영 */ }
            }

            // 모바일(hover 없음): 클릭으로 펼침/접힘. 평소 1칸으로 달 반사를 가리지 않는다.
            let collapseTimer = 0;
            function onPick(target, btn) {
                if (TOUCH_UI && elPanel) {
                    const wasExpanded = elPanel.classList.contains('expanded');
                    if (!wasExpanded) {
                        elPanel.classList.add('expanded');
                        moveThumb();
                        return;
                    }
                    if (btn && btn.classList.contains('on')) {
                        elPanel.classList.remove('expanded');
                        clearTimeout(collapseTimer);
                        moveThumb();
                        return;
                    }
                    goTo(target);
                    // thumb 슬라이드가 보이도록 잠시 펼침 유지 후 접기
                    clearTimeout(collapseTimer);
                    collapseTimer = setTimeout(() => {
                        elPanel.classList.remove('expanded');
                        moveThumb();
                    }, 900);
                    // 선택 직후 thumb를 새 위치로 (펼침 상태 기준)
                    setTimeout(() => moveThumb(), 0);
                    return;
                }
                goTo(target);
            }
            // 바깥 탭 시 접기 (모바일)
            if (TOUCH_UI) {
                document.addEventListener('pointerdown', e => {
                    if (!elPanel || !elPanel.classList.contains('expanded')) return;
                    if (e.target instanceof Element && elPanel.contains(e.target)) return;
                    elPanel.classList.remove('expanded');
                    clearTimeout(collapseTimer);
                    moveThumb();
                });
            }

            if (elDay) elDay.addEventListener('click', () => onPick('day', elDay));
            if (elDusk) elDusk.addEventListener('click', () => onPick('dusk', elDusk));
            if (elNight) elNight.addEventListener('click', () => onPick('night', elNight));
            if (elMirror) elMirror.addEventListener('click', () => onPick('mirror', elMirror));

            // ---------- debug bridge (F12 패널용) ----------
            // tsukuyomi.debug.js가 이 객체를 통해 모든 파라미터를 수동 조절한다.
            // CFG(수치) + 팔레트(색) + 상태(p/phi/state) + 재빌드 액션을 노출.
            window.__TSUKUYOMI__ = {
                cfg: CFG,
                defaults: CFG_DEFAULTS,
                get state() { return state; },
                set state(v) {
                    state = v;
                    if (v === 'day') { p = CFG.P_DAY; transFrom = p; transTo = p; transTarget = 'day'; duskW = 0; duskFrom = 0; duskTo = 0; nk = 0; nkFrom = 0; nkTo = 0; sunVis = svFrom = svTo = 1; phi = 0; phiTail = null; omega = 0; }
                    else if (v === 'dusk') { p = CFG.P_DUSK; transFrom = p; transTo = p; transTarget = 'dusk'; duskW = 1; duskFrom = 1; duskTo = 1; nk = 0; nkFrom = 0; nkTo = 0; sunVis = svFrom = svTo = 0; phi = 0; phiTail = null; omega = 0; }
                    else if (v === 'night') { p = 1; transFrom = 1; transTo = 1; transTarget = 'night'; duskW = 1; duskFrom = 1; duskTo = 1; nk = 1; nkFrom = 1; nkTo = 1; }
                    else if (v === 'toNight') {
                        if (!(p < 1)) p = CFG.P_DUSK;
                        { const qf = palQ(); p = qf; transFrom = qf; duskW = 0; duskFrom = 0; }
                        transTo = 1; transTarget = 'night'; duskTo = 1; nkFrom = nk; nkTo = 1; tState = 0;
                        phi = 0; phiTail = null; omega = 0;
                    }
                    else if (v === 'toDay' || v === 'toDusk') {
                        transTo = v === 'toDay' ? CFG.P_DAY : CFG.P_DUSK;
                        transTarget = v === 'toDay' ? 'day' : 'dusk';
                        duskTo = v === 'toDay' ? 0 : 1;
                        if (!(p >= 0 && p <= 1)) p = 1;
                        transFrom = p; duskFrom = duskW; nkFrom = nk; nkTo = 0; tState = 0;
                        svFrom = sunVis; svTo = v === 'toDay' ? 1 : 0;
                    }
                },
                get mode() { return activeOf(); }, set mode(v) { goTo(v); },
                get moonTarget() { return moonTarget; }, get mbMix() { return mbMix; }, get showT() { return showT; },
                show: SHOW, showDefaults: SHOW_DEF,
                get sunK() { return sunK(); },
                get W() { return W; }, get H() { return H; }, get HZ() { return HZ; }, get dpr() { return dpr; },
                // 포커스 오버레이(tsukuyomi.focus.js)용 랜드마크 화면 좌표 (css px)
                get torii() {
                    return {
                        x: torX, y: torY, w: torW, h: torH,
                        cx: torX + torW / 2, cy: torY + torH / 2, base: torBase,
                        visible: clamp(duskW, 0, 1) > 0.01
                    };
                },
                get moon() {
                    return { x: mbMX, y: mbMY, r: mbMR, v: mbMV, visible: mbMV > 0.05 && mbMR >= 2 };
                },
                get plainMoon() {
                    return { x: pmMX, y: pmMY, r: pmMR, v: pmMV, visible: pmMV > 0.05 && pmMR >= 2 };
                },
                // 브러시 구름 편집기(tsukuyomi.cloudedit.js)용: 라이브 캔버스 연결, 적용본 다시 읽기
                cloudEdit: {
                    setLive(k, canvas) { if (docCloud[k]) { docCloud[k].live = canvas || null; bandValid = false; } },
                    touch() { bandValid = false; },
                    reload(k) { loadCloudDoc(k); },
                },
                get cloudDocs() { return Object.fromEntries(Object.entries(docCloud).map(([k, D]) => [k, D.doc ? { src: D.src, w: D.doc.w, h: D.doc.h, baked: !!D.spr } : null])); },
                get nk() { return nk; }, set nk(v) { nk = clamp(Number(v) || 0, 0, 1); },
                get sunVis() { return sunVis; }, set sunVis(v) { sunVis = svFrom = svTo = clamp(Number(v) || 0, 0, 1); },
                get p() { return p; }, set p(v) { p = clamp(Number(v) || 0, 0, 1); },
                get q() { return palQ(); },
                get duskW() { return duskW; }, set duskW(v) { duskW = clamp(Number(v) || 0, 0, 1); },
                get duskQ() { return DUSK_Q; },
                get phi() { return phi; }, set phi(v) { phi = Number(v) || 0; },
                get phiTail() { return phiTail; }, set phiTail(v) { phiTail = v; },
                get moonMT() { return moonMT(palQ()); },
                get mbRot() { return mbRot; },
                set mbRot(v) { mbRot = ((Number(v) || 0) % 360 + 360) % 360; mbBodyRot = NaN; },
                get mbSpin() { return mbSpin; },
                set mbSpin(v) { mbSpin = !!v; },
                get mb() { return MB; },
                get mbDefaults() { return MB_DEFAULTS; },
                get mbStreaks() { return mbStreaks.length; },
                get omega() { return omega; }, set omega(v) { omega = Number(v) || 0; },
                get clock() { return clock; },
                get tState() { return tState; }, set tState(v) { tState = Number(v) || 0; },
                get tNight() { return tNight; }, set tNight(v) { tNight = Number(v) || 0; },
                get hold() { return debugHold; }, set hold(v) { debugHold = !!v; },
                get paused() { return debugPaused; }, set paused(v) { debugPaused = !!v; },
                get lanterns() { return lanterns; },
                get lanReady() { return lanReady; },
                get lanCached() { return lanCW > 0 && lanCH > 0; },
                get reflStep() { return reflStep; },
                get reflCost() { return reflEMA; },
                get torBuilds() { return torBuilds; },
                get bandBuilds() { return bandBuilds; },
                get day2Builds() { return day2Builds; },
                get day2W() { return day2W(); },
                get palettes() {
                    return {
                        SKY: SKY_RAW, SKY_DAY: SKY_DAY_RAW, SKY_DAY2: SKY_DAY2_RAW, MOUNT: MOUNT_RAW, MOUNT_DAY2: MOUNT_DAY2_RAW,
                        TORII: TORII_RAW, TORII_DAY2: TORII_DAY2_RAW, CLOUD_TINT: CLOUD_TINT_RAW, DCLOUD_TINT: DCLOUD_TINT_RAW,
                        DAY2_TINT: DAY2_TINT_RAW, REFL, REFL_DAY2, VIG, VIG_DAY2, LV, COLS: COLS_RAW
                    };
                },
                setPalette(name, raw) {
                    const parsed = JSON.parse(JSON.stringify(raw));
                    if (name === 'SKY') { SKY_RAW = skyTo5(parsed); SKY = prep(SKY_RAW); }
                    else if (name === 'SKY_DAY') { SKY_DAY_RAW = skyTo5(parsed); SKY_DAY = prep(SKY_DAY_RAW); }
                    else if (name === 'SKY_DAY2') { SKY_DAY2_RAW = skyTo5(parsed); SKY_DAY2 = prep(SKY_DAY2_RAW); }
                    else if (name === 'MOUNT') { MOUNT_RAW = parsed; MOUNT = prep(MOUNT_RAW); }
                    else if (name === 'MOUNT_DAY2') { MOUNT_DAY2_RAW = parsed; MOUNT_DAY2 = prep(MOUNT_DAY2_RAW); }
                    else if (name === 'TORII_DAY2') { TORII_DAY2_RAW = parsed; TORII_DAY2 = prep(TORII_DAY2_RAW); }
                    else if (name === 'DAY2_TINT') { DAY2_TINT_RAW = parsed; DAY2_TINT = prep(DAY2_TINT_RAW); }
                    else if (name === 'REFL_DAY2') { REFL_DAY2 = parsed; }
                    else if (name === 'VIG_DAY2') { VIG_DAY2 = parsed; }
                    else if (name === 'TORII') { TORII_RAW = parsed; TORII = prep(TORII_RAW); }
                    else if (name === 'CLOUD_TINT') { CLOUD_TINT_RAW = parsed; CLOUD_TINT = prep(CLOUD_TINT_RAW); }
                    else if (name === 'DCLOUD_TINT') { DCLOUD_TINT_RAW = parsed; DCLOUD_TINT = prep(DCLOUD_TINT_RAW); }
                    else if (name === 'REFL') { REFL = parsed; }
                    else if (name === 'VIG') { VIG = parsed; }
                    else if (name === 'LV') { LV = parsed; }
                    else if (name === 'COLS') { COLS_RAW = parsed; COLS = COLS_RAW.map(hex); }
                    else throw new Error('unknown palette: ' + name);
                },
                resetPalette(name, defaults) { this.setPalette(name, defaults); },
                actions: {
                    resize, buildStars, buildMountains, buildLanterns,
                    buildClouds() { buildClouds(); buildDuskClouds(); buildDay2Clouds(); buildDay2Extras(); },
                    reloadCloudDocs: loadCloudDocs,
                    goTo,
                    toNight() { goTo('night'); },
                    toDay() { goTo('day'); },
                    toDusk() { goTo('dusk'); },
                    reset() {
                        Object.assign(CFG, JSON.parse(JSON.stringify(CFG_DEFAULTS)));
                        // 구버전 스냅샷(MOON_X0/MOON_X1, W_FAST/DECAY/FAST_HOLD)으로 가져온 잔여 키 제거
                        delete CFG.MOON_X0; delete CFG.MOON_X1;
                        delete CFG.W_FAST; delete CFG.DECAY; delete CFG.FAST_HOLD;
                        reflStep = Math.max(1, Math.round(CFG.ROW_STEP)); reflLastBase = reflStep; reflEMA = 16; reflCool = 0;
                        torKey = ''; torRKey = ''; torBuilds = 0;
                        bandValid = false; bandTick = 0; bandLastP = -1; bandBuilds = 0;
                        // 기본값으로: INTRO_NIGHT면 황혼에서 밤으로 가는 인트로를 처음부터 다시 재생, 아니면 황혼 idle.
                        transFrom = 0; transTo = INTRO_NIGHT ? 1 : 0; transTarget = INTRO_NIGHT ? 'night' : 'dusk';
                        duskW = 1; duskFrom = 1; duskTo = 1;
                        nk = 0; nkFrom = 0; nkTo = INTRO_NIGHT ? 1 : 0;
                        sunVis = 0; svFrom = 0; svTo = 0;
                        state = INTRO_NIGHT ? 'toNight' : 'dusk'; p = 0; tState = 0; tNight = 0;
                        moonTarget = 'plain'; mbMix = 0; mbPending = false; showT = -1; showBeams = [];
                        phi = 0; phiTail = null; omega = 0; debugHold = false; debugPaused = false;
                        // 인트로 리플레이: 전환 UI를 다시 숨겼다가 완료 시점에 올린다
                        introDone = false;
                        if (elPanel) { elPanel.classList.remove('intro-enter'); elPanel.classList.add('intro-hidden'); }
                        buildMountains(); buildClouds(); buildDuskClouds(); buildDay2Clouds(); buildDay2Extras(); buildLanterns(); Object.assign(MB, JSON.parse(JSON.stringify(MB_DEFAULTS))); mbSpin = true; mbBuildAll(); mbRot = 0; resize();
                    },
                    mirrorburst() { mbFire(); },
                    // 미러볼 전환 연출 재생: 밤이면 일반 달에서 즉시 다시 시작, 아니면 밤 도착 후 실행
                    mirrorShow() {
                        if (state === 'night') { moonTarget = 'mirror'; mbMix = 0; startShow(); }
                        else { moonTarget = 'plain'; mbMix = 0; goTo('mirror'); }
                    },
                    mbBuild() { mbBuildAll(); },
                    mbTouch() { mbBodyRot = NaN; },
                    ripple(xn = 0.5, sn = 0.5) {
                        const cap = Math.min(RIP_SLOTS, Math.max(1, Math.round(CFG.RIP_MAX)));
                        if (ripples.length >= cap) ripples.shift();
                        ripples.push({ xn: clamp(xn, 0, 1), sn: clamp(sn, 0.02, 1), t: 0 });
                    },
                    clearRipples() { ripples.length = 0; },
                },
            };

            // ---------- loop ----------
            let lastT = performance.now();
            function frame(now) {
                const dt = Math.min(0.05, Math.max(0, (now - lastT) / 1000));
                lastT = now;
                update(dt);
                // 절차적 구름 타임랩스 갱신(동작 줄이기 설정이면 첫 장 그대로)
                if (cloudLive && CFG.CL_LIVE >= 0.5 && !RM.matches) cloudLive.tick(clock, now, CFG);
                // 브러시 구름 라이브 갱신(편집 중이 아닐 때, 켜진 장면만). 내부에서 fps로 솎아낸다
                for (const k in docCloud) {
                    const D = docCloud[k];
                    if (D.anim && !D.live && docOn(k)) D.anim.tick(clock);
                }
                stepRipples(dt);
                const t0 = performance.now();
                render();
                drawRipples();
                tickReflGovernor(performance.now() - t0);
                updateUI();
                requestAnimationFrame(frame);
            }

            let rt = 0;
            window.addEventListener('resize', () => {
                clearTimeout(rt);
                rt = setTimeout(resize, 120);
            });

            initGL();
            buildMountains();
            mbBuildAll();
            buildClouds();
            buildDuskClouds();
            buildDay2Clouds();
            buildDay2Extras();
            buildLanterns();
            loadLanternSprite();
            resize();
            loadCloudDocs();
            requestAnimationFrame(t => { lastT = t; frame(t); });
        })();
    
