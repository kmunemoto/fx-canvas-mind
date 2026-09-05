# FX Tactical Analyzer

AI がマルチタイムフレームの価格データからトレードプランを作り、実際の値動きで自動判定し、外れた理由を診断してルールブックに学習を積むアプリ。

- 判定・学習ループの不変条件と運用手順（契約、Bid/Ask 判定、精査の梯子、cron、デプロイ、秘密の扱い、既知の限界）: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- フロントエンド: React + TypeScript + Vite + Tailwind + shadcn/ui（`npm test` で vitest）
- バックエンド: Supabase（Postgres + pg_cron + Vault）と Deno のエッジ関数（`supabase/functions/`）
