/** Rebuild README examples offline from synthetic, account-free fixtures.
 * No config, UID, credential, production data, browser or network is used. */
import fs from 'node:fs/promises';
import {buildRecordModel, buildRecordCards} from '../lib/record-cards.mjs';
import {createNativeCardRenderer} from '../lib/native-card-renderer.mjs';

const output = new URL('../docs/images/', import.meta.url);
const render = createNativeCardRenderer();
const metadata = {nickname: '演示旅行者 · 合成数据', period: '演示数据 · 无真实账号'};
const people = [
  {id: 10000002, name: '神里绫华', level: 90, rarity: 5},
  {id: 10000089, name: '芙宁娜', level: 90, rarity: 5},
  {id: 10000047, name: '枫原万叶', level: 90, rarity: 5},
  {id: 10000054, name: '珊瑚宫心海', level: 90, rarity: 5},
];
const fixtures = [
  ['daily-note-demo.jpg', 'dailyNote', {
    current_resin: 128, max_resin: 200, resin_recovery_time: 34560,
    current_home_coin: 1560, max_home_coin: 2400,
    finished_task_num: 4, total_task_num: 4, is_extra_task_reward_received: true,
    remain_resin_discount_num: 2, resin_discount_num_limit: 3,
    max_expedition_num: 5,
    expeditions: [{status: 'Finished'}, {status: 'Finished'}, {status: 'Ongoing', remained_time: 7200}],
    transformer: {obtained: true, recovery_time: {reached: true}},
  }],
  ['abyss-demo.jpg', 'spiralAbyss', {
    max_floor: '12-3', total_battle_times: 24, total_star: 36,
    reveal_rank: people.map((person, index) => ({...person, value: 12 - index})),
    defeat_rank: [{...people[0], value: 72}],
    take_damage_rank: [{...people[3], value: 38640}],
    normal_skill_rank: [{...people[2], value: 56}],
    damage_rank: [{...people[0], value: 128600}],
    energy_skill_rank: [{...people[1], value: 32}],
  }],
];

// Preserve the native card. The badge is documentation-only; avatars retain
// the renderer's own fallback because no external game assets are downloaded.
function markDemo(card) {
  return {...card, svg: card.svg.replace('</svg>', '<g font-family="Microsoft YaHei,Noto Sans CJK SC,sans-serif"><rect x="802" y="30" width="230" height="48" rx="12" fill="#efd6a0"/><text x="917" y="62" text-anchor="middle" font-size="24" font-weight="700" fill="#17313d">演示数据</text></g></svg>')};
}

await fs.mkdir(output, {recursive: true});
for (const [filename, kind, data] of fixtures) {
  const cards = buildRecordCards(buildRecordModel(kind, data, metadata));
  if (!cards?.[0]) throw new Error('Native demo builder returned no card');
  const bytes = await render(markDemo(cards[0]));
  await fs.writeFile(new URL(filename, output), bytes);
  console.log(`${filename}: ${cards[0].width} x ${cards[0].height}, ${bytes.length} bytes`);
}
