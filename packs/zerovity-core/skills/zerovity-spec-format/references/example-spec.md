# ZF-214 Two-step approval for refunds over $10k

Status: Draft

## 1. Problem and outcome
Refunds of any size are approved by one person. Finance wants a second approver from `finance-ops` for refunds of $10,000 or more. Success: no refund at or above the threshold can reach `APPROVED` with fewer than two distinct approvers.

## 2. Scope
In scope: refund approval API, approval status model, audit entries.
Out of scope: UI changes, changing the threshold per currency.

## 3. Requirements
- R1. A refund below $10,000 keeps the current single-approver flow.
- R2. A refund at or above $10,000 must move to `PENDING_2ND` after the first approval.
- R3. The second approver must belong to group `finance-ops` and be a different person from the first.
- R4. Every approval writes an audit entry with approver, time and amount.

## 4. Acceptance criteria
- AC1 (R1) Given a $9,999.99 refund, when one approver signs, then status is `APPROVED`. Check: unit test `refund.approve.spec.ts`.
- AC2 (R2) Given a $12,000 refund, when one approver signs, then status is `PENDING_2ND`. Check: integration test.
- AC3 (R3) Given the first approver signs again, then the call fails with `SAME_APPROVER`. Check: unit test.
- AC4 (R4) Given any approval, then one audit row exists with the approver id. Check: integration test.

## 5. Technical design
`src/refunds/approve.ts` gains `requiredApprovals(amount)`; table `refund_approvals` stores one row per approver; migration `0042_refund_approvals.sql` (reversible).

## 6. Risks and open points
- Threshold currency: assumed USD. Needs confirmation for EUR refunds.

## 7. Traceability
| R | AC | Check |
|---|----|-------|
| R1 | AC1 | refund.approve.spec.ts |
| R2 | AC2 | refund.flow.int.ts |
| R3 | AC3 | refund.approve.spec.ts |
| R4 | AC4 | refund.flow.int.ts |
