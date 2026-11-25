import test from 'node:test';
import assert from 'node:assert/strict';
import {isDailyReviewDue} from '../workers/paper-scheduler.js';
test('paper scheduler retains legacy dedicated daily cron compatibility',()=>{assert.equal(isDailyReviewDue({cron:'5 0 * * *'}),true);});
test('paper scheduler runs the daily review from its single per-minute trigger at 00:05 UTC',()=>{assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,0,5)}),true);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,0,4)}),false);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,12,5)}),false);});
test('paper scheduler ignores missing or invalid scheduled timestamps for the daily review',()=>{assert.equal(isDailyReviewDue({cron:'*/1 * * * *'}),false);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:'invalid'}),false);});
