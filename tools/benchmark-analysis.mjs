import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { analyze } from '../dist/src/analysis.js';
import { defaults, newPlayer } from '../dist/src/model.js';
const ids = Array.from({length: 150}, (_, i) => String(76561197960265729n + BigInt(i)));
const settings = {...defaults, includeGames: true};
const players = ids.map((id, i) => ({...newPlayer(id, i ? 1 : 0, settings),
  name: id, visibility: 'public', friendsStatus: 'public', friends: i ? [ids[0]] : ids.slice(1),
  groupsStatus: 'public', groups: [], gamesStatus: 'public', games: i ? [i, 30001 + i] : Array.from({length:30000}, (_, j) => j + 1),
}));
const scan = {version:2, id:'benchmark', seed:ids[0], createdAt:'2026-10-19T00:00:00Z', updatedAt:'2026-10-19T00:00:00Z', status:'complete', error:null, settings, players, queue:[], truncated:false};
const result = analyze(scan);
if (process.argv[2] === '--record') writeFileSync(process.argv[3], JSON.stringify(result));
if (process.argv[2] === '--compare') assert.deepEqual(result, JSON.parse(readFileSync(process.argv[3], 'utf8')));
const times=[];
for(let i=0;i<7;i++){const start=performance.now();analyze(scan);times.push(performance.now()-start);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({players:players.length,seedGames:players[0].games.length,medianMs:times[3],samplesMs:times}));
