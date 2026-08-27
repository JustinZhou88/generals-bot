'use strict';

/**
 * 游戏状态维护:负责应用官方协议的 map_diff / cities_diff 增量补丁,
 * 并提供邻接、距离、可见性等基础查询工具。
 *
 * 地图编码(官方协议):
 *   map = [width, height, ...armies(size), ...terrain(size)]
 *   terrain:  >=0 玩家编号 | -1 空地 | -2 山 | -3 迷雾 | -4 迷雾中的障碍(山或城)
 */

const TILE_EMPTY = -1;
const TILE_MOUNTAIN = -2;
const TILE_FOG = -3;
const TILE_FOG_OBSTACLE = -4;

/** 官方 diff 补丁算法:交替读取 [保留数, 替换数, ...替换值] */
function patch(old, diff) {
  const out = [];
  let i = 0;
  while (i < diff.length) {
    if (diff[i]) {
      out.push(...old.slice(out.length, out.length + diff[i]));
    }
    i++;
    if (i < diff.length && diff[i]) {
      out.push(...diff.slice(i + 1, i + 1 + diff[i]));
      i += diff[i];
    }
    i++;
  }
  return out;
}

class GameState {
  constructor() {
    this.playerIndex = -1;
    this.map = [];
    this.cities = [];      // 已知城市的 tile 下标
    this.generals = [];    // 各玩家将军位置(未知为 -1)
    this.turn = 0;
    this.scores = [];
    this.width = 0;
    this.height = 0;
    this.size = 0;
    this.armies = [];
    this.terrain = [];

    // 记忆:迷雾里也别忘了见过的东西
    this.knownCities = new Set();
    this.knownGenerals = new Map();   // playerIndex -> tile
    this.discoveredMountains = new Set();
    // 曾经看见过的格子(永久记忆)。敌方将军不会移动,所以凡是看过一眼而没有将军的
    // 格子都可以永久排除 —— terrain===-3 只表示"此刻看不见",走过一次的地方
    // 过几十回合又变回迷雾,不区分的话侦察会反复重扫已排除区域。
    this.everSeen = null; // 首次 update 时按地图尺寸分配
  }

  start(data) {
    this.playerIndex = data.playerIndex;
    this.replayUrl = 'https://bot.generals.io/replays/' + encodeURIComponent(data.replay_id);
    this.usernames = data.usernames;
    this.teams = data.teams;
  }

  update(data) {
    this.map = patch(this.map, data.map_diff);
    this.cities = patch(this.cities, data.cities_diff);
    this.generals = data.generals;
    this.turn = data.turn;
    this.scores = data.scores;

    this.width = this.map[0];
    this.height = this.map[1];
    this.size = this.width * this.height;
    this.armies = this.map.slice(2, this.size + 2);
    this.terrain = this.map.slice(this.size + 2, this.size + 2 + this.size);

    for (const c of this.cities) this.knownCities.add(c);
    for (let p = 0; p < this.generals.length; p++) {
      if (this.generals[p] >= 0) this.knownGenerals.set(p, this.generals[p]);
    }
    if (!this.everSeen || this.everSeen.length !== this.size) this.everSeen = new Uint8Array(this.size);
    for (let t = 0; t < this.size; t++) {
      if (this.terrain[t] === TILE_MOUNTAIN) this.discoveredMountains.add(t);
      if (this.terrain[t] >= TILE_EMPTY) this.everSeen[t] = 1; // >= -1 即当前可见
    }
    // 若已确认某玩家将军被打掉/换位(阵亡后地块归属改变),校正记忆
    for (const [p, tile] of this.knownGenerals) {
      if (this.isVisible(tile) && this.generals[p] !== tile && this.generals[p] === -1) {
        // 可见但官方数据说这里已不是他的将军 → 该玩家可能已死
        if (this.terrain[tile] !== p) this.knownGenerals.delete(p);
      }
    }
  }

  // ---------- 基础查询 ----------

  row(t) { return Math.floor(t / this.width); }
  col(t) { return t % this.width; }
  tileAt(r, c) { return r * this.width + c; }

  /** 曼哈顿距离(启发式用) */
  dist(a, b) {
    return Math.abs(this.row(a) - this.row(b)) + Math.abs(this.col(a) - this.col(b));
  }

  /** 上下左右可走邻居(不含山) */
  neighbors(t) {
    const res = [];
    const r = this.row(t), c = this.col(t);
    if (r > 0) res.push(t - this.width);
    if (r < this.height - 1) res.push(t + this.width);
    if (c > 0) res.push(t - 1);
    if (c < this.width - 1) res.push(t + 1);
    return res.filter((n) => this.isPassable(n));
  }

  isPassable(t) {
    const ter = this.terrain[t];
    if (ter === TILE_MOUNTAIN) return false;
    if (this.discoveredMountains.has(t)) return false;
    // 迷雾障碍可能是城:除非已知是城,否则当作不可走,避免撞山浪费
    if (ter === TILE_FOG_OBSTACLE && !this.knownCities.has(t)) return false;
    return true;
  }

  isVisible(t) {
    return this.terrain[t] >= TILE_EMPTY; // >= -1
  }

  isMine(t) { return this.terrain[t] === this.playerIndex; }

  /** 可扩张的开阔地:可见空地(-1)或平雾(-3,必无山/城——障碍在雾中显示为 -4) */
  isOpenLand(t) {
    const ter = this.terrain[t];
    return (ter === TILE_EMPTY || ter === TILE_FOG) && !this.knownCities.has(t) && !this.discoveredMountains.has(t);
  }

  isCity(t) { return this.knownCities.has(t); }

  /** 这个格子从来没被看见过吗(敌将只可能藏在这些格子里) */
  isUnseen(t) { return !this.everSeen || !this.everSeen[t]; }

  isEnemy(t) {
    const ter = this.terrain[t];
    return ter >= 0 && ter !== this.playerIndex && !this.isTeammate(ter);
  }

  isTeammate(playerIdx) {
    if (!this.teams) return false;
    return this.teams[playerIdx] === this.teams[this.playerIndex] && playerIdx !== this.playerIndex;
  }

  myGeneral() { return this.generals[this.playerIndex]; }

  myTiles() {
    const res = [];
    for (let t = 0; t < this.size; t++) if (this.isMine(t)) res.push(t);
    return res;
  }

  /** 我方总兵力 / 总地块(来自 scores,包含迷雾中的信息) */
  myScore() {
    return this.scores.find((s) => s.i === this.playerIndex) || { total: 0, tiles: 0 };
  }

  /** 存活的敌人分数,按兵力排序 */
  enemyScores() {
    return this.scores
      .filter((s) => s.i !== this.playerIndex && !s.dead && !this.isTeammate(s.i))
      .sort((a, b) => b.total - a.total);
  }
}

module.exports = { GameState, patch, TILE_EMPTY, TILE_MOUNTAIN, TILE_FOG, TILE_FOG_OBSTACLE };
