'use strict';

// 数据目录的选择与迁移 —— 单独抽出来是为了能被单元测试钉住。
//
// 这里解决的是用户最不能接受的一类问题：「一更新，对话和配置就没了」。
// 从前踩过的坑：
//   1. 只看「哪个目录先可写」就选它 → %APPDATA% 可写性一变就换目录，
//      用户打开软件发现一片空白，以为数据被删了。
//   2. 选到的目录写不进去时，**默默换一个空目录**继续跑 → 同样表现为「东西没了」。
// 现在的规矩：
//   · 优先用「真正有数据」的那个目录（按接口数 + 消息数打分，空壳不算数）
//   · 如果它写不进去，就**把数据搬**到可写目录再继续 —— 绝不让用户对着空界面
//   · 搬家只复制、不删除源目录，留足后路

const fs = require('fs');
const path = require('path');

/** 一个目录里有多少「真东西」：-1 没文件 / 0 空壳 / >0 有接口或消息 */
function dataScore(dir) {
  try {
    const f = path.join(dir, 'data.json');
    if (!fs.existsSync(f) || fs.statSync(f).size < 3) return -1;
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return -1;
    const j = JSON.parse(raw);
    const conns = Array.isArray(j.connections) ? j.connections.length : 0;
    const convs = Array.isArray(j.conversations) ? j.conversations : [];
    const msgs = convs.reduce((n, c) => n + ((c.messages || []).length), 0);
    if (!conns && !msgs) return 0;   // 建过对话但一句话没说、也没有接口 = 空壳
    return conns * 2 + msgs;
  } catch {
    return -1;
  }
}

/** 读一个目录里的数据概要（给界面/日志用） */
function dataSummary(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8').replace(/^\uFEFF/, ''));
    const convs = Array.isArray(j.conversations) ? j.conversations : [];
    return {
      connections: (j.connections || []).length,
      conversations: convs.length,
      messages: convs.reduce((n, c) => n + ((c.messages || []).length), 0),
    };
  } catch {
    return null;
  }
}

/** 把数据从一个目录搬到另一个目录（只复制，不删源） */
function migrateData(fromDir, toDir) {
  const copied = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(toDir, { recursive: true });
    const srcJson = path.join(fromDir, 'data.json');
    const dstJson = path.join(toDir, 'data.json');
    if (fs.existsSync(srcJson)) {
      if (fs.existsSync(dstJson)) {
        // 目标已有文件：先另存一份，绝不直接覆盖
        try { fs.copyFileSync(dstJson, dstJson + '.replaced-' + stamp); } catch { /* 忽略 */ }
      }
      fs.copyFileSync(srcJson, dstJson);
      copied.push('data.json');
    }
    const srcFiles = path.join(fromDir, 'files');
    if (fs.existsSync(srcFiles)) {
      const dstFiles = path.join(toDir, 'files');
      fs.mkdirSync(dstFiles, { recursive: true });
      for (const name of fs.readdirSync(srcFiles)) {
        const d = path.join(dstFiles, name);
        if (fs.existsSync(d)) continue;
        try { fs.copyFileSync(path.join(srcFiles, name), d); copied.push('files/' + name); } catch { /* 忽略 */ }
      }
    }
  } catch (err) {
    return { copied, error: err.message };
  }
  return { copied, error: null };
}

/**
 * 选出这次要用的数据目录。
 * @param {string[]} candidates 候选目录（按优先级排好）
 * @param {(dir:string)=>boolean} isWritable 可写性判断（注入以便单测）
 * @returns {{dir:string, score:number, warning:string|null, movedFrom:string|null, movedTo:string|null, copied:string[]}}
 */
function pickDataDir(candidates, isWritable) {
  const scored = candidates.map((dir) => ({
    dir,
    score: dataScore(dir),
    writable: !!isWritable(dir),
  }));

  let best = null;
  for (const c of scored) {
    if (c.score > 0 && (!best || c.score > best.score)) best = c;
  }

  if (best) {
    if (best.writable) {
      return { dir: best.dir, score: best.score, warning: null, movedFrom: null, movedTo: null, copied: [], scored };
    }
    const target = scored.find((c) => c.writable && c.dir !== best.dir);
    if (target) {
      const { copied, error } = migrateData(best.dir, target.dir);
      const warning =
        '原来的数据目录现在写不进去：\n' + best.dir +
        '\n\n已经把你的数据搬到：\n' + target.dir +
        '\n（搬了 ' + copied.length + ' 项' + (error ? '，有一步失败：' + error : '') +
        '；原来那个目录里的东西没有删，还在）' +
        '\n\n常见原因是权限变化、安全软件拦截，或者那个盘变成只读了。';
      return {
        dir: target.dir, score: target.score, warning,
        movedFrom: best.dir, movedTo: target.dir, copied, scored,
      };
    }
    // 一个可写的都没有：只能用它（至少能把对话读出来看）
    return { dir: best.dir, score: best.score, warning: null, movedFrom: null, movedTo: null, copied: [], scored };
  }

  // 各处都没有真数据（第一次运行）
  for (const c of scored) if (c.writable) {
    return { dir: c.dir, score: c.score, warning: null, movedFrom: null, movedTo: null, copied: [], scored };
  }
  return { dir: candidates[0], score: -1, warning: null, movedFrom: null, movedTo: null, copied: [], scored };
}

module.exports = { dataScore, dataSummary, migrateData, pickDataDir };
