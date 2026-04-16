# Implementation Plan: Breakpoint Auto-Resume + Context Snapshot Prototype

## Objective
Thiết kế và triển khai prototype cho extension CDS Debug với hành vi:
1. Có option cấu hình để quyết định có dừng ở breakpoint hay không.
2. Mặc định **không dừng** ở breakpoint (để tránh block remote shared service).
3. Khi hit breakpoint, extension chụp context variables (giống vùng Variables trong Run and Debug) rồi mới tự động continue.
4. Bổ sung UI/UX hiển thị danh sách snapshot breakpoint theo dạng list + detail (phù hợp trường hợp hit liên tục nhiều lần trong vài giây).
5. Kiểm thử bằng Playwright (unit/e2e hiện có + MCP Playwright snapshot cho prototype UI).

## Research Summary (Completed)
1. `src/core/processManager.ts` quản lý tunnel + attach, nhưng chưa xử lý debug adapter `stopped` event để can thiệp breakpoint.
2. `src/webview/debugPanel.ts` là bridge message giữa extension và webview; đây là điểm phù hợp để push dữ liệu snapshot xuống UI.
3. `src/webview/webviewScript.ts` + `src/webview/webviewRenderers.ts` đang dùng state machine theo message; dễ mở rộng thêm trạng thái snapshot list/detail.
4. `src/types/index.ts` là nơi khai báo contract message giữa extension/webview.
5. Bộ e2e hiện tại đã có pattern test bằng injected message cho UI lifecycle; có thể mở rộng test snapshot mà không phụ thuộc remote debugger thật.
6. Không tồn tại thư mục `designs/prototypes` trong workspace hiện tại, nên cần tạo mới để chứa prototype HTML phục vụ review UI độc lập.

## Scope and Files
1. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/core/breakpointSnapshotManager.ts` (new)
   - module mới: lắng nghe `onDidReceiveDebugSessionCustomEvent`, bắt `stopped` reason=`breakpoint`, snapshot stack/scopes/variables, redact thông tin nhạy cảm, auto-continue theo setting.
2. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/extension.ts`
   - khởi tạo/cleanup breakpoint snapshot manager trong activate/deactivate.
3. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/types/index.ts`
   - thêm kiểu dữ liệu snapshot context và message extension↔webview liên quan breakpoint snapshots.
4. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/webview/debugPanel.ts`
   - subscribe event snapshot mới và forward xuống webview.
   - thêm message handler clear snapshot.
5. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/webview/webviewScript.ts`
   - bổ sung state + message handler + listener cho list/detail snapshot.
6. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/webview/webviewRenderers.ts`
   - render section “Breakpoint Snapshots” dạng list bên trái / detail bên dưới (compact, chịu tải nhiều hit).
7. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/src/webview/webviewStyles.ts`
   - style cho snapshot list/detail, empty state, selected row, scroll behavior.
8. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/package.json`
   - thêm cấu hình `cdsDebug.pauseOnBreakpoint` (default=false) + mô tả hành vi.
9. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/e2e/tests/extension-smoke.spec.ts`
   - thêm test UI cho snapshot list/detail + clear action bằng injected message.
10. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/designs/prototypes/breakpoint-snapshot-prototype.html` (new)
    - prototype HTML độc lập để review UX nhanh.
11. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/designs/prototypes/README.md` (new, ngắn)
    - cách mở prototype.

## Implementation Steps
1. Tạo module snapshot manager:
   - nghe custom event debug;
   - nếu `reason=breakpoint` và session thuộc CDS (`Debug: <app>`), capture top stack frame + scopes + variables;
   - redact value khi tên biến mang pattern nhạy cảm (`password`, `token`, `secret`, `key`, `authorization`, ...);
   - giới hạn dữ liệu snapshot (max entries, max scopes, max variables) để tránh freeze UI;
   - auto-continue thread khi `cdsDebug.pauseOnBreakpoint=false`.
2. Kết nối manager vào lifecycle extension:
   - init ở `activate`, dispose ở `deactivate`.
3. Mở rộng message contract types:
   - thêm `BreakpointContextSnapshot` và message `BREAKPOINT_SNAPSHOTS`, `BREAKPOINT_SNAPSHOT_ADDED`, `CLEAR_BREAKPOINT_SNAPSHOTS`.
4. Cập nhật debugPanel bridge:
   - push initial snapshot list khi `LOAD_CONFIG`;
   - push incremental snapshot khi có event mới;
   - xử lý clear từ webview.
5. Cập nhật UI webview:
   - thêm section snapshot trong READY screen;
   - list hiển thị compact theo thời gian/app/location;
   - click item để xem detail variables;
   - hỗ trợ clear all;
   - không làm giật active sessions panel.
6. Thêm config setting:
   - `cdsDebug.pauseOnBreakpoint` mặc định `false`.
7. Viết prototype HTML trong `designs/prototypes`:
   - mô phỏng list/detail với dữ liệu nhiều hits liên tục.
8. Cập nhật e2e test:
   - verify hiển thị list snapshot;
   - verify chọn item đổi detail;
   - verify clear action.
9. Verification:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm cspell`
   - `pnpm --dir e2e test` (nếu thời gian cho phép; nếu không, chạy scope test liên quan và báo rõ)
10. Dùng MCP Playwright mở prototype HTML, chụp snapshot và tinh chỉnh nhanh UI spacing/readability nếu cần.
11. Kết thúc:
   - tăng patch version trong `package.json` sau khi hoàn thiện,
   - không commit theo yêu cầu hiện tại.

## Risks and Mitigation
1. Debug adapter custom request không luôn trả đủ dữ liệu variables:
   - fallback snapshot với metadata + captureError, vẫn auto-continue để tránh block service.
2. Hit breakpoint dồn dập gây spam UI:
   - cắt ngưỡng snapshot tối đa và render list dạng virtual-ish (scroll container + row compact).
3. Lộ dữ liệu nhạy cảm trong variables:
   - redact theo pattern tên biến trước khi gửi webview.
4. Tăng độ phức tạp file webview vốn lớn:
   - chỉ thêm các helper cần thiết, tránh refactor lan rộng để giảm regression.

## Acceptance Criteria
1. Mặc định extension **không pause** khi hit breakpoint; app tự continue.
2. Mỗi lần hit breakpoint tạo được 1 snapshot context (hoặc snapshot lỗi có metadata nếu capture thất bại).
3. UI có danh sách snapshot hit theo thời gian; click item xem chi tiết variables.
4. Tương tác nhiều hit liên tiếp vẫn usable (không tràn layout, không khó đọc).
5. Có setting `cdsDebug.pauseOnBreakpoint` để bật lại hành vi pause truyền thống.
6. Build/lint/typecheck/test đạt hoặc nếu có chỗ chưa chạy được phải nêu rõ lý do.
7. `cspell` đạt, e2e scope thay đổi đạt và version được tăng.

## Addendum: Prototype Navigation Refinement

### Goal
Điều chỉnh prototype để phản ánh đúng flow thực tế:
1. Người dùng vào từ màn hình `Debug Launcher`.
2. Nhấn CTA để vào màn hình `Breakpoint Snapshots`.
3. Trong màn hình `Breakpoint Snapshots` có nút quay về `Debug Launcher`.
4. Bỏ chữ `Prototype` trong tiêu đề/nhãn UI hiển thị với người dùng.

### Files
1. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/designs/prototypes/breakpoint-snapshot-prototype.html`
   - chia layout thành 2 screen (launcher + breakpoint snapshots),
   - thêm state điều hướng client-side và nút back,
   - đổi title/header text bỏ chữ Prototype.
2. `/Users/dongtran/Documents/brain/01-projects/13-cds-debug/designs/prototypes/README.md`
   - cập nhật mô tả flow navigation mới.

### Verification
1. Mở prototype bằng Playwright.
2. Xác nhận:
   - màn đầu là `Debug Launcher`,
   - click CTA vào được `Breakpoint Snapshots`,
   - nút `Back to Debug Launcher` hoạt động,
   - UI không còn chữ `Prototype` ở heading/title hiển thị.
3. Chụp snapshot desktop + mobile để rà UX.
