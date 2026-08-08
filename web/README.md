# web

Vite + React dashboard, served static from S3 via CloudFront, behind Cognito.

Chosen over QuickSight (no native DynamoDB source, per-reader pricing), Managed
Grafana (~$9/user/month, shaped for ops metrics) and Streamlit (needs a
container and ALB, costing more than the rest of the stack combined).
