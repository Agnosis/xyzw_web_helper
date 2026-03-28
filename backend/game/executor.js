'use strict';

const { GameClient } = require('./wsClient');
const { parseGameToken } = require('./tokenParser');

const COMMAND_DELAY = 500;

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute a single named task for a single game token.
 */
async function executeTaskForToken(taskName, tokenData, batchSettings, log) {
  const actualToken = parseGameToken(tokenData);
  const client = new GameClient(actualToken, {
    log,
    connectTimeout: (batchSettings && batchSettings.connectionTimeout) || 15000,
  });

  try {
    log(`连接游戏服务器: ${tokenData.name || tokenData.id}`);
    await client.connect();
    log(`已连接: ${tokenData.name || tokenData.id}`, 'success');

    await runTask(taskName, client, batchSettings, log);
  } finally {
    client.disconnect();
  }
}

/**
 * Execute multiple tasks for multiple tokens.
 * Tokens are processed in concurrent batches; tasks within each token run sequentially.
 */
async function executeScheduledTask(task, userTokens, batchSettings, log) {
  const selectedTokenIds = JSON.parse(task.selected_token_ids || '[]');
  const selectedTasks = JSON.parse(task.selected_tasks || '[]');

  const tokensToRun = userTokens.filter((t) => selectedTokenIds.includes(t.id));

  if (tokensToRun.length === 0) {
    log('没有可用的 token，请检查任务配置或重新保存 token', 'error');
    throw new Error('No tokens available for this task');
  }

  if (selectedTasks.length === 0) {
    log('没有选择任何子任务，请检查任务配置', 'error');
    throw new Error('No sub-tasks selected for this task');
  }

  const MAX_CONCURRENT = (batchSettings && batchSettings.maxActive) || 2;

  // Process tokens in batches of MAX_CONCURRENT
  for (let i = 0; i < tokensToRun.length; i += MAX_CONCURRENT) {
    const batch = tokensToRun.slice(i, i + MAX_CONCURRENT);
    await Promise.all(
      batch.map(async (tokenData) => {
        for (const taskName of selectedTasks) {
          try {
            await executeTaskForToken(taskName, tokenData, batchSettings, log);
            await delay((batchSettings && batchSettings.taskDelay) || COMMAND_DELAY);
          } catch (err) {
            log(`任务 ${taskName} 失败 [${tokenData.name || tokenData.id}]: ${err.message}`, 'error');
          }
        }
      }),
    );
  }
}

/**
 * Run a specific named task using an already-connected GameClient.
 */
async function runTask(taskName, client, settings, log) {
  const cmdDelay = (settings && settings.commandDelay) || COMMAND_DELAY;

  async function cmd(cmdName, params = {}) {
    const result = await client.sendWithPromise(cmdName, params, 10000);
    await delay(cmdDelay);
    return result;
  }

  switch (taskName) {
    case 'claimHangUpRewards':
      log('领取挂机奖励...');
      await cmd('system_claimhangupreward');
      for (let i = 0; i < 4; i++) {
        await cmd('system_mysharecallback', { isSkipShareCard: true, type: 2 });
      }
      log('挂机奖励领取完成', 'success');
      break;

    case 'batchAddHangUpTime':
      log('一键加钟...');
      for (let i = 0; i < 4; i++) {
        await cmd('system_mysharecallback', { isSkipShareCard: true, type: 2 });
      }
      log('加钟完成', 'success');
      break;

    case 'resetBottles':
      log('重置罐子...');
      await cmd('bottlehelper_stop', { bottleType: -1 });
      await cmd('bottlehelper_start', { bottleType: -1 });
      log('罐子重置完成', 'success');
      break;

    case 'batchlingguanzi':
      log('一键领取罐子...');
      await cmd('bottlehelper_claim');
      log('罐子领取完成', 'success');
      break;

    case 'batchLegacyClaim':
      log('领取功法残卷挂机奖励...');
      await cmd('legacy_claimhangup');
      log('功法残卷领取完成', 'success');
      break;

    case 'batchclubsign':
      log('俱乐部签到...');
      await cmd('legion_signin');
      log('俱乐部签到完成', 'success');
      break;

    case 'collection_claimfreereward':
      log('免费领取珍宝阁...');
      await cmd('collection_claimfreereward');
      log('珍宝阁领取完成', 'success');
      break;

    case 'startBatch':
      log('开始执行日常任务...');
      await runDailyBatch(client, settings, log);
      break;

    // === 爬塔类 ===
    case 'climbTower':
      log('一键爬塔...');
      await cmd('tower_getinfo', {}, '获取爬塔信息');
      await cmd('fight_starttower', {}, '开始爬塔');
      log('爬塔完成', 'success');
      break;

    case 'climbWeirdTower':
      log('一键爬怪异塔...');
      await cmd('evotower_getinfo', {}, '获取怪异塔信息');
      await cmd('evotower_readyfight', {}, '准备战斗');
      await cmd('evotower_fight', { battleNum: 1, winNum: 1 }, '怪异塔战斗');
      log('怪异塔完成', 'success');
      break;

    case 'batchClaimFreeEnergy':
      log('领取怪异塔免费道具...');
      await cmd('mergebox_getinfo', { actType: 1 }, '获取道具信息');
      await cmd('mergebox_claimfreeenergy', { actType: 1 }, '领取免费道具');
      log('免费道具领取完成', 'success');
      break;

    case 'skinChallenge':
      log('换皮闯关...');
      await cmd('towers_getinfo', {}, '获取活动信息');
      await cmd('towers_start', { towerType: 1 }, '开始挑战');
      await cmd('towers_fight', { towerType: 1 }, '换皮战斗');
      log('换皮闯关完成', 'success');
      break;

    // === 商店类 ===
    case 'legion_storebuygoods':
      log('一键购买四圣碎片...');
      await cmd('legion_storebuygoods', { id: 6 }, '购买四圣碎片');
      log('四圣碎片购买完成', 'success');
      break;

    case 'store_purchase':
      log('黑市采购...');
      await cmd('store_purchase', {}, '黑市采购');
      log('黑市采购完成', 'success');
      break;

    // === 竞技场类 ===
    case 'batcharenafight':
      log('一键竞技场战斗...');
      await cmd('arena_startarea', {}, '开始竞技场');
      await cmd('fight_startareaarena', { targetId: 0 }, '竞技场战斗');
      log('竞技场战斗完成', 'success');
      break;

    // === 宝库梦境类 ===
    case 'batchbaoku13':
      log('一键宝库前3层...');
      await cmd('bosstower_getinfo', {}, '获取宝库信息');
      await cmd('bosstower_startboss', {}, '宝库BOSS');
      await cmd('bosstower_startbox', {}, '宝库开箱');
      log('宝库前3层完成', 'success');
      break;

    case 'batchbaoku45':
      log('一键宝库4,5层...');
      await cmd('bosstower_getinfo', {}, '获取宝库信息');
      await cmd('bosstower_startboss', {}, '宝库BOSS');
      log('宝库4,5层完成', 'success');
      break;

    case 'batchmengjing':
      log('一键梦境...');
      await cmd('dungeon_selecthero', { battleTeam: { 0: 107 } }, '选择梦境阵容');
      log('梦境完成', 'success');
      break;

    // === 开箱钓鱼招募类 ===
    case 'batchOpenBox':
      log('批量开箱...');
      await cmd('item_openbox', { itemId: 2001, number: 10 }, '开箱');
      await cmd('item_batchclaimboxpointreward', {}, '领取宝箱积分');
      log('开箱完成', 'success');
      break;

    case 'batchOpenBoxByPoints':
      log('按积分开箱...');
      await cmd('item_openbox', { itemId: 2001, number: 10 }, '开箱');
      log('按积分开箱完成', 'success');
      break;

    case 'batchClaimBoxPointReward':
      log('领取宝箱积分...');
      await cmd('item_batchclaimboxpointreward', {}, '领取宝箱积分');
      log('宝箱积分领取完成', 'success');
      break;

    case 'batchFish':
      log('批量钓鱼...');
      await cmd('artifact_lottery', { type: 1, lotteryNumber: 10, newFree: true }, '钓鱼');
      await cmd('artifact_exchange', {}, '领取累计奖励');
      log('钓鱼完成', 'success');
      break;

    case 'batchRecruit':
      log('批量招募...');
      await cmd('hero_recruit', { recruitType: 1, recruitNumber: 10 }, '招募');
      log('招募完成', 'success');
      break;

    // === 灯神扫荡 ===
    case 'batchGenieSweep':
      log('灯神扫荡...');
      await cmd('genie_sweep', { genieId: 1, sweepCnt: 1 }, '灯神扫荡');
      log('灯神扫荡完成', 'success');
      break;

    // === 蟠桃园 ===
    case 'batchClaimPeachTasks':
      log('领取蟠桃园任务...');
      await cmd('legion_getpayloadtask', {}, '获取蟠桃任务');
      await cmd('legion_claimpayloadtask', { taskId: 1 }, '领取任务奖励');
      log('蟠桃园任务完成', 'success');
      break;

    // === 车辆类 ===
    case 'batchClaimCars':
      log('一键收车...');
      await cmd('car_getrolecar', {}, '获取车辆信息');
      await cmd('car_claim', { carId: '0' }, '收车');
      log('收车完成', 'success');
      break;

    case 'batchSmartSendCar':
      log('智能发车...');
      await cmd('car_getrolecar', {}, '获取车辆信息');
      await cmd('car_send', { carId: '0', helperId: 0, text: '', isUpgrade: false }, '发车');
      log('智能发车完成', 'success');
      break;

    // === 道具合成类 ===
    case 'batchUseItems':
      log('使用道具...');
      await cmd('mergebox_getinfo', { actType: 1 }, '获取道具信息');
      await cmd('mergebox_openbox', { actType: 1, pos: { gridX: 4, gridY: 5 } }, '使用道具');
      await cmd('mergebox_claimcostprogress', { actType: 1 }, '领取累计奖励');
      log('使用道具完成', 'success');
      break;

    case 'batchMergeItems':
      log('一键合成...');
      await cmd('mergebox_getinfo', { actType: 1 }, '获取合成信息');
      await cmd('mergebox_claimmergeprogress', { actType: 1, taskId: 1 }, '领取合成奖励');
      await cmd('mergebox_automergeitem', { actType: 1 }, '自动合成');
      log('一键合成完成', 'success');
      break;

    // === 功法赠送 ===
    case 'batchLegacyGiftSendEnhanced':
      log('批量赠送功法残卷...');
      await cmd('legacy_sendgift', { itemCnt: 1, legacyUIds: [] }, '赠送功法');
      log('功法赠送完成', 'success');
      break;

    default:
      log(`未知任务: ${taskName}`, 'warning');
  }
}

/**
 * Run the full daily batch of common game tasks.
 */
async function runDailyBatch(client, settings, log) {
  const cmdDelay = (settings && settings.commandDelay) || COMMAND_DELAY;

  async function cmd(cmdName, params = {}, desc = '') {
    try {
      if (desc) log(`执行: ${desc}`);
      const result = await client.sendWithPromise(cmdName, params, 10000);
      await delay(cmdDelay);
      if (desc) log(`${desc} 完成`, 'success');
      return result;
    } catch (err) {
      if (desc) log(`${desc} 失败: ${err.message}`, 'warning');
      return null;
    }
  }

  // Get role info
  await cmd(
    'role_getroleinfo',
    {
      clientVersion: '2.20.1-e249aa927a8ffe4c-wx',
      inviteUid: 0,
      platform: 'hortor',
      platformExt: 'mix',
      scene: '',
    },
    '获取角色信息',
  );

  // Claim hangup rewards
  await cmd('system_claimhangupreward', {}, '领取挂机奖励');
  for (let i = 0; i < 4; i++) {
    await cmd('system_mysharecallback', { isSkipShareCard: true, type: 2 });
  }

  // Sign in
  await cmd('system_signinreward', {}, '签到');

  // Daily task rewards
  for (let rewardId = 1; rewardId <= 10; rewardId++) {
    await cmd('task_claimdailyreward', { rewardId }, `领取日常任务奖励${rewardId}`);
  }

  // Claim email attachments
  await cmd('mail_claimallattachment', { category: 0 }, '领取邮件附件');

  // Legion signin
  await cmd('legion_signin', {}, '俱乐部签到');

  // Collection free reward
  await cmd('collection_claimfreereward', {}, '珍宝阁免费领取');

  log('日常任务执行完成', 'success');
}

module.exports = { executeScheduledTask, executeTaskForToken };
