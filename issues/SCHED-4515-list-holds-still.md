---
id: SCHED-4515
title: List holds still; "N new" bar brings new incidents in
status: done
plan: R1, R2
---

Product's decision after the step-1 recording (00:08): a new incident landed on top while on-call aimed at
INC-1950, the list moved down one row, and the click acked INC-8220.

> The list holds still while it is on screen; a "N new" bar brings new incidents in on click. Ack stays on the row. — product

- Rows on screen are never moved or removed by a refresh; they are updated in place.
- New incidents wait behind the bar (`data-testid="new-bar"`, "N new incidents · show"); a click puts them on top, newest first.
- The bar sits in a slot of fixed height, so showing it does not move the list. The error message is a toast, for the same reason.
- Ack stays on each row (`data-testid="ack"`).

Acceptance: leave the board open while new incidents come in: the rows do not move, the bar counts them, a click on it brings them in on top. An ack aimed at a row while one comes in acks that row.
