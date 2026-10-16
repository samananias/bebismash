# 0002 — Upgrade local Wrangler tooling

Date: 2026-10-16
Status: accepted
Owner: Core/Router (Integration Owner)

## Context

The user requested the latest Wrangler after local Pages startup failed under Wrangler 3.114.17.

## Decision

Upgrade Wrangler to 4.151.0 and its Workers type definitions to 5.20261016.1 using pnpm. Keep resolved dependencies in pnpm-lock.yaml. Node 24 remains the project runtime.

## Consequences

This changes development tooling and edge type definitions. It does not provision or deploy Cloudflare resources. Pages still rejects custom configuration paths; upgrading does not by itself fix that command.

## Validation

Wrangler version, TypeScript, lint, unit tests, and the SQLite migration test are checked during this upgrade. Local Pages startup is checked separately from remote deployment.
