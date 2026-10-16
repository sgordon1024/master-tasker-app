#!/usr/bin/env node
// Stands in for osascript in tests. Writes the notification's arguments to MT_NOTIFY_LOG.
import fs from 'node:fs';
fs.appendFileSync(process.env.MT_NOTIFY_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
