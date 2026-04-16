# Implementation Plan: Debug Launcher Navigation to Breakpoint Snapshots

## Objective
Bổ sung flow điều hướng rõ ràng trong extension CDS Debug:
1. Trên màn `Debug Launcher` có button rõ ràng để mở màn `Breakpoint Snapshots`.
2. Màn `Breakpoint Snapshots` có button quay về `Debug Launcher`.
3. Dữ liệu snapshot vẫn realtime khi đang ở cả 2 màn liên quan.

## Scope Analysis
1. `src/webview/webviewScript.ts`
   - Mở rộng state machine với screen mới cho snapshot.
   - Điều chỉnh message handler để refresh panel khi ở màn snapshot mới.
2. `src/webview/webviewRenderers.ts`
   - Thêm renderer cho màn `Breakpoint Snapshots`.
   - Thêm button điều hướng từ `Debug Launcher`.
   - Thêm button quay về launcher.
3. `src/webview/webviewStyles.ts`
   - Bổ sung style cho button điều hướng và layout panel full-screen snapshot.
4. `e2e/tests/extension-smoke.spec.ts`
   - Thêm test điều hướng launcher → snapshot → launcher.
   - Cập nhật các test snapshot hiện có để đi qua flow button mới.
5. `package.json`
   - Tăng pre-release version sau khi hoàn thiện.

## Flow and Edge Cases
1. User ở `Debug Launcher` nhưng chưa có snapshot:
   - Vẫn mở được màn snapshot, thấy empty state rõ ràng.
2. Snapshot cập nhật realtime khi user đang ở màn snapshot:
   - `BREAKPOINT_SNAPSHOT_ADDED` phải refresh panel ngay.
3. User đang ở màn snapshot, bấm clear:
   - Danh sách reset và giữ nguyên màn hiện tại.
4. User quay về launcher:
   - Không mất state apps/session/snapshot đã có.
5. Layout hẹp (webview sidebar):
   - Nút điều hướng cần ngắn gọn, không phá bố cục header.

## Implementation Steps
1. Thêm screen mới `BREAKPOINT_SNAPSHOTS` vào state machine.
2. Tạo renderer riêng cho màn snapshot và chuyển panel snapshot ra màn dedicated.
3. Thêm button `Open Breakpoint Snapshots` ở header launcher.
4. Thêm button `Back to Launcher` ở màn snapshot.
5. Cập nhật listener điều hướng + điều kiện refresh panel theo screen.
6. Cập nhật e2e tests theo flow mới, tên test mô tả hành vi người dùng.
7. Tăng version pre-release trong `package.json`.

## Verification Checklist
1. Chạy lint:
   - `pnpm run lint`
2. Chạy typecheck:
   - `pnpm run typecheck`
3. Chạy unit test:
   - `pnpm run test`
4. Chạy cspell:
   - `pnpm run cspell`
5. Chạy e2e test và phân tích log:
   - `pnpm --prefix e2e test -- --grep "Breakpoint Snapshot"`
   - Nếu pass ổn định, chạy full `pnpm --prefix e2e test`
6. Nếu có lỗi:
   - Sửa root cause và chạy lại toàn bộ checklist.

## Release & SCM Steps
1. Tăng version pre-release trong `package.json`.
2. Commit các thay đổi (không bypass git hooks).
3. Push lên `master`.
4. Theo dõi workflow publish bằng `gh run watch` và kiểm tra log publish.

## Acceptance Criteria
1. Trong `Debug Launcher` có button điều hướng tới `Breakpoint Snapshots`.
2. Màn `Breakpoint Snapshots` có button quay về `Debug Launcher`.
3. Snapshot list/detail hoạt động đúng như trước.
4. E2E mới/cập nhật pass và không gây regression.
5. Lint/typecheck/test/cspell pass.
6. Version pre-release được tăng, commit + push hoàn tất.
