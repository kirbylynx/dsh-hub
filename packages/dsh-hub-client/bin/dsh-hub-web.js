#!/usr/bin/env node
import { main } from '../src/plugin-web.js';

process.exitCode = await main(process.argv.slice(2));
