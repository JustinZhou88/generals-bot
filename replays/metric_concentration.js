// 兵力集中度指标: 最大兵团占比/规模、将军格驻军占比、前5兵团合计占比
// 高手语料 vs bot 自对弈,同一把尺子。
'use strict';
const fs = require('fs');
const path = require('path');
const Game = require('./Game');

const SAMPLE_HALF = [100, 200, 300]; // 真实回合 t50/t100/t150 (turn是半回合)

// 采样某玩家在当前 game 状态下的集中度数据
function sampleConc(game, p) {
	const sc = game.scores.find(s => s.i === p);
	if (!sc || sc.dead || sc.total <= 0 || sc.tiles <= 0) return null;
	const N = game.map.size();
	const armies = [];
	for (let t = 0; t < N; t++) {
		if (game.map.tileAt(t) === p) armies.push(game.map.armyAt(t));
	}
	if (armies.length === 0) return null;
	armies.sort((a, b) => b - a);
	const total = sc.total;
	const max1 = armies[0];
	let top5 = 0;
	for (let i = 0; i < Math.min(5, armies.length); i++) top5 += armies[i];
	const genTile = game.generals[p];
	const genArmy = (genTile >= 0 && game.map.tileAt(genTile) === p) ? game.map.armyAt(genTile) : 0;
	return {
		maxShare: max1 / total,
		maxAbs: max1,
		genShare: genArmy / total,
		top5Share: top5 / total,
	};
}

// 累加器: 按半回合采样点分桶
function newAcc() {
	const acc = {};
	for (const h of SAMPLE_HALF) acc[h] = { maxShare: [], maxAbs: [], genShare: [], top5Share: [] };
	return acc;
}
function pushSample(acc, h, s) {
	if (!s) return;
	acc[h].maxShare.push(s.maxShare);
	acc[h].maxAbs.push(s.maxAbs);
	acc[h].genShare.push(s.genShare);
	acc[h].top5Share.push(s.top5Share);
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

// ---------- 高手语料 ----------
function runExpert() {
	const pick = JSON.parse(fs.readFileSync(path.join(__dirname, 'pro', 'pick.json'), 'utf8'));
	const acc = newAcc();
	let games = 0;
	for (const player of Object.keys(pick)) {
		for (const entry of pick[player]) {
			const file = path.join(__dirname, 'pro', entry.id + '.json');
			if (!fs.existsSync(file)) continue;
			const r = JSON.parse(fs.readFileSync(file, 'utf8'));
			const me = r.usernames.indexOf(player);
			if (me < 0) continue;
			games++;
			const game = Game.createFromReplay(r);
			let mi = 0;
			const targets = new Set(SAMPLE_HALF);
			while (!game.isOver() && game.turn < 1200) {
				while (r.moves.length > mi && r.moves[mi].turn <= game.turn) {
					const m = r.moves[mi++];
					game.handleAttack(m.index, m.start, m.end, m.is50);
				}
				if (targets.has(game.turn)) {
					pushSample(acc, game.turn, sampleConc(game, me));
				}
				game.update();
			}
		}
	}
	return { acc, games };
}

// ---------- bot 自对弈 ----------
function runBot() {
	const { injectView, loadReplays } = require('../arena');
	const { GameState } = require('../src/gamestate');
	const { Strategy } = require('../src/strategy');
	const maps = loadReplays().slice(0, 12);
	const acc = newAcc();
	let games = 0;
	for (const r of maps) {
		const game = Game.createFromReplay(r);
		const gsA = new GameState();
		gsA.start({ playerIndex: 0, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
		const gsB = new GameState();
		gsB.start({ playerIndex: 1, replay_id: 'x', usernames: ['A', 'B'], teams: undefined });
		const A = new Strategy(gsA), B = new Strategy(gsB);
		games++;
		while (!game.isOver() && game.turn < 800) {
			injectView(gsA, game, 0);
			let a = null; try { a = A.nextMove(); } catch (e) {}
			injectView(gsB, game, 1);
			let b = null; try { b = B.nextMove(); } catch (e) {}
			if (a) game.inputBuffer[0].push([a.from, a.to, !!a.is50]);
			if (b) game.inputBuffer[1].push([b.from, b.to, !!b.is50]);
			if (SAMPLE_HALF.includes(game.turn)) {
				pushSample(acc, game.turn, sampleConc(game, 0));
				pushSample(acc, game.turn, sampleConc(game, 1));
			}
			game.update();
		}
	}
	return { acc, games };
}

function report(label, res) {
	console.log('==== ' + label + ' (games=' + res.games + ') ====');
	for (const h of SAMPLE_HALF) {
		const b = res.acc[h];
		console.log('t' + (h / 2) + ' n=' + b.maxShare.length +
			' maxShare=' + (mean(b.maxShare) * 100).toFixed(1) + '%' +
			' maxAbs=' + mean(b.maxAbs).toFixed(1) +
			' genShare=' + (mean(b.genShare) * 100).toFixed(1) + '%' +
			' top5Share=' + (mean(b.top5Share) * 100).toFixed(1) + '%');
	}
	// 三点平均
	const avg = k => mean(SAMPLE_HALF.map(h => mean(res.acc[h][k])).filter(x => !isNaN(x)));
	console.log('AVG maxShare=' + (avg('maxShare') * 100).toFixed(1) + '%' +
		' maxAbs=' + avg('maxAbs').toFixed(1) +
		' genShare=' + (avg('genShare') * 100).toFixed(1) + '%');
}

const expert = runExpert();
report('EXPERT', expert);
const bot = runBot();
report('BOT', bot);
