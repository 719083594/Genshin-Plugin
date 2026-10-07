import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecordModel,buildRecordCards,buildRecordText,supportedRecordKinds,supportsRecordKind} from '../lib/record-cards.mjs';
import {createNativeCardRenderer} from '../lib/native-card-renderer.mjs';

const people=[{id:10000002,name:'神里绫华',level:90,rarity:5},{id:10000089,name:'芙宁娜',level:90,rarity:5},{id:10000047,name:'枫原万叶',level:90,rarity:5},{id:10000054,name:'珊瑚宫心海',level:90,rarity:5}];
const floor=index=>({index,star:9,max_star:9,levels:[1,2,3].map(index=>({index,star:3,max_star:3,battles:[{timestamp:1791280800,avatars:people},{timestamp:1791280860,avatars:people}]}))});
function fakeSharp(){const factory=(svg)=>{const source=svg.toString(),width=Number(/<svg[^>]* width="(\d+)"/.exec(source)[1]),height=Number(/<svg[^>]* height="(\d+)"/.exec(source)[1]);return {jpeg(){return this},timeout(){return this},async toBuffer(){return {data:Buffer.from([255,216,1,2,255,217]),info:{format:'jpeg',width,height}}}}};factory.cache=()=>{};factory.concurrency=()=>{};factory.versions={sharp:'0.35.5'};return factory}

test('supported record kinds have safe native SVG and readable independent text, including sparse responses',async()=>{
 const render=createNativeCardRenderer({loadSharp:()=>fakeSharp()});
 assert.equal(supportedRecordKinds.size,17);assert.equal(supportsRecordKind('unsupported'),false);
 for(const kind of supportedRecordKinds){for(const data of [{},null,{data:[null],list:[null]}]){
  const model=buildRecordModel(kind,data),plain=buildRecordText(model),cards=buildRecordCards({model});
  assert(plain.length>0);assert(!plain.startsWith('{'));assert(cards.length>=1&&cards.length<=8);
  for(const card of cards){assert.equal(card.width,1080);assert.equal(card.private,true);assert(card.height<12000);assert(card.width*card.height<=12000000);assert.doesNotMatch(card.svg,/<script|<style|<foreignObject|https:\/\/upload|NaN|undefined|null/);assert(Buffer.isBuffer(await render(card)))}
 }}
 assert.throws(()=>buildRecordModel('unsupported',{}),/UNSUPPORTED_RECORD_KIND/);
});

test('query data is allowlisted before rendering; account secrets, unknown fields and URL credentials are discarded',()=>{
 const model=buildRecordModel('character',{list:[{...people[0],cookie:'secret-credential',authkey:'secret-authkey',icon:'https://upload-bbs.miyoushe.com/game_record/avatar.png?token=secret-query#secret-hash'},{id:10000089,name:'测试',icon:'https://127.0.0.1/secret'}],cookie:'secret-credential',hidden:{secret:'secret-deep'}},{uid:'100000001',nickname:'合成示例'});
 const result=JSON.stringify(model);assert.doesNotMatch(result,/secret-|cookie|authkey|hidden/);assert.equal(model.characters[0].icon,'https://upload-bbs.miyoushe.com/game_record/avatar.png');assert.equal(model.characters[1].icon,'');
 assert.equal(buildRecordModel('character',{}, {uid:'not-a-uid'}).uid,'');
});

test('the screenshot empty abyss remains honest: no fabricated stars, rankings, wins or teams',()=>{
 const model=buildRecordModel('spiralAbyss',{max_floor:'10-3',total_battle_times:0,total_win_times:0,reveal_rank:[],defeat_rank:[],damage_rank:[],take_damage_rank:[],floors:[]},{period:'本期'});
 assert.equal(model.empty,true);assert.equal(model.stats.find(s=>s.label==='最深抵达').value,'10-3');assert.equal(model.stats.find(s=>s.label==='战斗次数').value,'0');assert.equal(model.stats.find(s=>s.label==='获得星数').value,'—');assert.equal(model.floors.length,0);assert(model.rankings.every(r=>r.entries.length===0));
 const cards=buildRecordCards(model);assert.equal(cards.length,1);assert.match(cards[0].svg,/暂无挑战记录/);assert.doesNotMatch(cards[0].svg,/>36<|>12-3<|神里绫华/);assert.match(buildRecordText(model),/获得星数：—/);
});

test('abyss cards preserve period, each chamber, both teams and ranking numbers in bounded pages',async()=>{
 const model=buildRecordModel('spiralAbyss',{max_floor:'12-3',total_battle_times:6,total_star:36,damage_rank:[{...people[0],value:1672543}],floors:[floor(11),floor(12)]},{period:'上期'});
 const cards=buildRecordCards(model),plain=buildRecordText(model);assert.equal(cards.length,2);assert.match(cards[0].svg,/上期/);assert.match(cards[0].svg,/1,672,543/);assert.match(cards[1].svg,/第 11 层/);assert.match(cards[1].svg,/第 12 层/);assert.equal((cards[1].svg.match(/>上半</g)||[]).length,6);assert.equal((cards[1].svg.match(/>下半</g)||[]).length,6);assert.equal((cards[1].svg.match(/>神里绫华</g)||[]).length,12);assert.match(plain,/第 3 间/);assert.match(plain,/Lv\.90/);
 const render=createNativeCardRenderer({loadSharp:()=>fakeSharp()});for(const card of cards)await render(card);
 const full=buildRecordCards(buildRecordModel('spiralAbyss',{floors:Array.from({length:12},(_,i)=>floor(i+1))}));assert.equal(full.length,7);assert(full.every(c=>c.height*c.width<=12000000));
});

test('daily notes distinguish actual zero and unreturned fields and keep extra reward state',()=>{
 const model=buildRecordModel('dailyNote',{current_resin:0,max_resin:200,resin_recovery_time:96000,current_home_coin:0,max_home_coin:2400,finished_task_num:4,total_task_num:4,is_extra_task_reward_received:true});
 assert.equal(model.stats[0].value,'0 / 200');assert.match(model.stats[0].detail,/26小时40分/);assert.match(buildRecordText(model),/额外奖励已领取/);
 assert.equal(buildRecordModel('dailyNote',{}).stats[0].value,'— / —');
 assert.equal(buildRecordModel('dailyNote',{}).stats[2].value,'— / —');
 for(const [seconds,expected]of [[1,'1分钟'],[3599,'1小时'],[3600,'1小时'],[3601,'1小时1分'],[7199,'2小时'],[7200,'2小时']]){const daily=buildRecordModel('dailyNote',{current_resin:0,max_resin:200,resin_recovery_time:seconds});assert.equal(daily.stats[0].detail,'回满还需 '+expected)}
 const rewards=buildRecordText(buildRecordModel('dailyNote',{daily_task:{attendance_rewards:[{status:'Taken'},{status:'Ready'},{status:'Locked'}]}}));assert.match(rewards,/已领取奖励：1\/3/);assert.doesNotMatch(rewards,/可领取奖励/);
 for(const kind of ['character','detail','deckList','tcgCards'])assert.equal(buildRecordModel(kind,{}).stats[0].value,'—');
});

test('observed challenge and theater schema aliases preserve precise seconds, period selection and round teams',()=>{
 const challenge=buildRecordModel('hard_challenge',{data:[{single:{has_data:false},mp:{has_data:false}},{schedule:{start_time:1790784000,end_time:1793462399},single:{has_data:true,best:{difficulty:6,second:135},challenge:[{name:'合成对手',second:41,teams:people.map(a=>({...a,avatar_id:a.id,id:undefined}))}]},mp:{has_data:false}}]},{period:'上期'});
 assert.equal(challenge.stats[2].value,'2分15秒');assert.match(buildRecordText(challenge),/最佳用时 41秒/);assert.match(buildRecordText(challenge),/队伍：神里绫华 Lv.90/);assert.equal(challenge.sections[0].rows[0].characters[0].id,'10000002');assert.match(challenge.period,/上期/);
 const noChallenge=buildRecordModel('hard_challenge',{data:[{single:{has_data:false,best:{difficulty:0,second:0}},mp:{has_data:false,best:{difficulty:0,second:0}}}]});assert.equal(noChallenge.empty,true);assert(noChallenge.stats.every(s=>s.value==='—'));
 const mixed=buildRecordModel('hard_challenge',{data:[{single:{has_data:true,best:{difficulty:4,second:100},challenge:[{name:'单人对手',second:100}]},mp:{has_data:true,best:{difficulty:6,second:200},challenge:[{name:'多人对手',second:200}]}}]});assert.equal(mixed.sections[0].rows[0].value,'难度 4');assert.equal(mixed.sections[1].rows[0].value,'难度 6');
 const theater=buildRecordModel('role_combat',{data:[{stat:{max_round_id:10,get_medal_round_list:[1,2],difficulty_id:4},schedule:{start_date_time:{year:2026,month:10,day:1},end_date_time:{year:2026,month:11,day:1}},detail:{fight_statisic:{total_use_time:583},rounds_data:[{round_id:1,is_get_medal:true,finish_time:1791280800,avatars:people}]}}]},{period:'本期'});
 assert.match(theater.period,/2026\.10\.01 — 2026\.11\.01/);assert.match(buildRecordText(theater),/9分43秒/);assert.match(buildRecordText(theater),/队伍：神里绫华/);assert.match(buildRecordCards(theater).map(c=>c.svg).join(''),/神里绫华/);
 const calendar=buildRecordModel('act_calendar',{act_list:[{name:'合成活动',status:2,countdown_seconds:3600}],fixed_act_list:[{name:'深境螺旋',type:'ActTypeTower',tower_detail:{has_data:true,total_star:0,max_star:36}}]});assert.match(buildRecordText(calendar),/剩余时间 1小时/);assert.match(buildRecordText(calendar),/0 \/ 36 星/);
 assert.match(buildRecordText(buildRecordModel('compute',{avatar_skill_consume:[{name:'摩拉',num:100}]})),/天赋培养材料/);
});

test('new endpoints have dedicated rows rather than exposing arbitrary JSON',()=>{
 const fixtures=[
  ['ledger',{month_data:{current_primogems:60,current_mora:1000,group_by:[{action:'每日活跃',num:60,percent:100}]}},/每日活跃/],
  ['gcg/basicInfo',{level:10,avatar_card_num_gained:6,avatar_card_num_total:100},/6 \/ 100/],
  ['deckList',{deck_list:[{name:'合成牌组',avatar_cards:[{name:'琴'}]}]},/合成牌组/],
  ['tcgCards',{card_list:[{name:'合成卡牌',num:2}]},/合成卡牌/],
  ['act_calendar',{activities:[{name:'合成活动',start_time:1791280800,end_time:1791284400}]},/合成活动/],
  ['compute',{overall_consume:[{name:'摩拉',num:12000}]},/12,000/],
  ['blueprint',{name:'合成方案',furniture_list:[{name:'松木长桌',cnt:2}]},/松木长桌/],
  ['blueprintCompute',{materials:[{name:'松木',num:16}]},/松木/],
  ['coinBalance',{points:120},/米游币余额：120/],
  ['coinMissions',{total_points:100,states:[{mission_id:59,process:2,is_get_award:false}]},/奖励未领取/]
 ];for(const [kind,data,expected]of fixtures){const model=buildRecordModel(kind,{...data,private_unknown:'do-not-display'});assert.match(buildRecordText(model),expected);assert.doesNotMatch(buildRecordCards(model).map(c=>c.svg).join(''),/do-not-display|private_unknown/)}
});

test('XML text escaping and portrait transport cannot introduce active content or arbitrary external images',async()=>{
 const model=buildRecordModel('character',{list:[{...people[0],name:'<script>&"',icon:'https://evil.invalid/payload.svg'}]},{nickname:'<image href="file:///secret"/>&'});
 for(const uri of ['https://evil.invalid/portrait.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,not+canonical','file:///secret']){
  const cards=buildRecordCards(model,{assets:{avatars:{10000002:uri}}});assert.doesNotMatch(cards[0].svg,/<script|<image /);assert.match(cards[0].svg,/&lt;script&gt;/);assert.match(cards[0].svg,/&lt;image href=&quot;file:\/\/\/secret&quot;\/&gt;&amp;/);await createNativeCardRenderer({loadSharp:()=>fakeSharp()})(cards[0]);
 }
});

test('large collections paginate to at most eight images, with an explicit continuation note',()=>{
 const model=buildRecordModel('character',{list:Array.from({length:120},(_,i)=>({...people[0],id:10000000+i,name:'合成角色'+i}))});
 const cards=buildRecordCards(model);assert(cards.length>1&&cards.length<=8);assert.match(cards.at(-1).title,/\//);assert.match(cards.at(-1).svg,/合成角色119/);
 const lots=buildRecordModel('index',{avatars:Array(24).fill(people[0]),world_explorations:Array(12).fill({name:'地区',exploration_percentage:1000})});lots.sections.push(...Array.from({length:20},()=>({title:'更多记录',rows:Array(12).fill({label:'条目',value:'数值',detail:'说明'})})));
 const capped=buildRecordCards(lots);assert.equal(capped.length,8);assert.match(capped.at(-1).svg,/完整资料请用「文字」/);
});
