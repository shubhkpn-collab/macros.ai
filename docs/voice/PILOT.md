# MACROS voice economics pilot

Status: instrumentation implemented; customer pilot has not started. API credit is currently exhausted. No participants have been contacted, no subscription price has been chosen, and no cheaper model has been enabled.

## Decision to test

Can MACROS deliver a useful hands-free kitchen experience with a total recurring cost that supports a price customers will pay?

Planning scenario: 15 minutes/day × 30 days = 450 minutes/month. The equal-speaking-time new-audio baselines discussed are approximately $21.60 for the current full model and $6.75 for mini. These are not total costs or forecasts. Recheck vendor prices before analysis.

## Pilot sequence

1. Founder test: five minutes on the current voice model. Record actual provider charges and success; do not infer cost from elapsed time alone.
2. Compare a lower-cost voice model using the same meal tasks and similar conversation lengths. Keep the full model as the control; switching models requires a configured backend restart, not retraining.
3. Recruit a small, consenting group (suggested 5–10 people) for a week. Ask them to use it naturally, including food corrections and interruptions. Recruitment and recording interviews require separate user action/authorization.
4. Ask willingness to pay after use, without presenting a price first. Then test candidate prices. An expression of interest is weaker evidence than a paid commitment.
5. Review median and heavy-user cost, task success and willingness to pay before hardware orders or an unlimited voice promise.

## Measurements

The app records a bounded local ledger (latest 100 connected sessions) of elapsed connected time, response count, provider-reported input/output tokens, cached input tokens, input/output audio tokens, and responses with missing usage. It stores no audio, transcripts, food entries, account identity or credentials in this ledger. It currently has no export UI or automatic cloud collection. It is diagnostic data, not a billing ledger: an interrupted connection may lose final usage events, and transcription, other services and backend charges are separate. Reconcile against the provider billing dashboard.

For each participant/day collect: connected minutes, actual API dollars, hosting allocation, support time, successful meals logged, failed/duplicate logs, interruptions handled, repeated clarification turns, and whether manual interaction was needed. Separately record usefulness and willingness to pay. Use pseudonymous participant labels; do not collect personal food history for cost analysis.

## Pricing worksheet

Monthly variable cost = measured voice/API cost + other model/transcription costs + hosting + support + payment fees + other recurring delivery costs.

Contribution margin = (net subscription revenue − monthly variable cost) / net subscription revenue.

For a chosen margin, required net revenue = monthly variable cost / (1 − margin). Compare this with observed willingness to pay, including heavy users. Hardware manufacturing, returns, warranty and acquisition costs need their own model; they are not covered by an AI-only margin.

Choose pass/fail thresholds before reviewing pilot results. Proposed discussion targets: at least 95% correct food-task completion, zero unauthorized or duplicate saves, and a subscription that covers heavy-user variable costs with the margin the business requires. These targets are hypotheses, not achieved results. If quality or economics fail, revise the interaction/model/allowance and repeat the test before committing to launch.
