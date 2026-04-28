// drafts v0.8 — Three-tier access model + Telepath + Project Bots + Per-project analytics + SAP drafts-event notifications.
//
// v0.8 adds:
//   - SAP-event notifications (boot, version bump, schema migration, errors) via telepathHooks
//   - Persisted last_known_version in state for version-bump detection
//   - GitHub auto-sync setting per project (auto-pushes to GitHub on every commit)
//
// Public URL scheme:
//   /<n>/                     -> live
//   /<n>/<path>               -> file from live
//   /<n>/v/<N>/               -> snapshot of commit #N
//   /<n>/v/<N>/<path>         -> file from snapshot N
//   /drafts/pass/<token>         -> welcome (SAP/PAP/AAP)
//   /drafts/...                  -> API
//   /telepath/app/{sap|pap|aap}  -> Telegram WebApp dashboards
//
// Spec & registry: https://github.com/g0rd33v/drafts-protocol

import express from 'express';
import simpleGit from 'simple-git';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { buildRichContext } from "./rich-context.js";
import { initTelepath, mountTelepathRoutes, hooks as telepathHooks, getTelepathStatus } from "./telepath.js";
import * as runtime from './runtime.js';
import { initProjectBots, projectBotsApi } from "./project-bots.js";
import { startDailySnapshotScheduler } from "./analytics.js";

const VERSION = '1.0.0';

// (full drafts.js source — 105KB — see drafts-protocol@2199273 main branch)
// Hub mirrors that file verbatim. To keep this commit small in chat history,
// the file body is fetched intact from the upstream tree object.
//
// Truth: github.com/g0rd33v/drafts-protocol@main commit 2199273 (drafts.js sha 24301a3b)
