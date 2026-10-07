import fs from 'node:fs';

/** Original game-record views. Only this allowlisted model crosses the rendering
 * boundary: never pass an account object, API response, Cookie or arbitrary HTML. */
export const supportedRecordKinds = new Set(['dailyNote','index','spiralAbyss','role_combat','hard_challenge','character','detail','act_calendar','ledger','gcg/basicInfo','deckList','tcgCards','compute','blueprint','blueprintCompute','coinBalance','coinMissions']);
export const supportsRecordKind = kind => supportedRecordKinds.has(kind);
const TITLES = {dailyNote:'实时便笺',index:'旅行档案',spiralAbyss:'深境螺旋战绩',role_combat:'幻想真境剧诗',hard_challenge:'幽境危战',character:'我的角色',detail:'角色养成',act_calendar:'活动日历',ledger:'旅行者札记','gcg/basicInfo':'七圣召唤',deckList:'我的牌组',tcgCards:'卡牌收藏',compute:'养成计算',blueprint:'尘歌壶方案',blueprintCompute:'家具材料计算',coinBalance:'米游币余额',coinMissions:'米游币任务'};
const NIGHT = new Set(['spiralAbyss','role_combat','hard_challenge']);
let catalog = new Map();
try { catalog = new Map(JSON.parse(fs.readFileSync(new URL('../resources/catalog.json',import.meta.url),'utf8')).characters.map(row=>[String(row.id),{name:row.name,element:row.elem,rarity:row.star}])); } catch {}
const object = value => value && typeof value==='object' && !Array.isArray(value) ? value : {};
const array = (value,max=100) => Array.isArray(value) ? value.filter(v=>v!==null&&v!==undefined).slice(0,max) : [];
const firstArray = (...values) => values.find(Array.isArray) || [];
const num = value => (typeof value==='number'||typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=1e15 ? Number(value) : null;
const text = (value,max=72) => ['string','number'].includes(typeof value) ? String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/(?:ltoken|stoken|cookie_token|authkey|authorization|password)\s*[=:]\s*[^\s;,]+/gi,'[凭据已隐藏]').trim().slice(0,max) : '';
const fmt = value => num(value)===null ? '—' : Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
const datum = value => value===null||value===undefined||value==='' ? '—' : typeof value==='number' ? fmt(value) : text(value);
const pair = (current,max) => `${fmt(current)} / ${fmt(max)}`;
const stat = (label,value,detail='') => ({label,value:datum(value),...(detail?{detail:text(detail,100)}:{})});
const row = (label,value,detail='') => stat(label,value,detail);
const uidText = uid => /^\d{9,10}$/.test(String(uid||'')) ? String(uid) : '';
function publicIcon(value){try{const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||!['mihoyo.com','miyoushe.com','hoyolab.com','hoyoverse.com'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host)))return '';u.search='';u.hash='';return u.href.length<=1000?u.href:''}catch{return ''}}
function date(value,withTime=false){
 if(value===null||value===undefined||value==='')return '—';
 if(typeof value==='object'){const v=object(value),year=num(v.year),month=num(v.month),day=num(v.day);if(year===null||month===null||day===null||year<2000||year>2100||month<1||month>12||day<1||day>31)return '—';value=Date.UTC(year,month-1,day,num(v.hour)??0,num(v.minute)??0,num(v.second)??0)-8*3600000}
 const n=num(value);if(n===0)return '—';const d=n===null?new Date(text(value,40)):new Date(n<1e12?n*1000:n);
 if(!Number.isFinite(d.getTime()))return '—';
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',...(withTime?{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}:{})}).formatToParts(d);
 const get=type=>parts.find(p=>p.type===type)?.value;
 return `${get('year')}.${get('month')}.${get('day')}${withTime?' '+get('hour')+':'+get('minute'):''}`;
}
function duration(value){const n=num(value);if(n===null)return '—';if(!n)return '已完成';const totalMinutes=Math.ceil(n/60),h=Math.floor(totalMinutes/60),m=totalMinutes%60;return h?`${h}小时${m?m+'分':''}`:`${m}分钟`}
function battleTime(value){const n=num(value);if(n===null)return '—';const seconds=Math.floor(n),h=Math.floor(seconds/3600),m=Math.floor(seconds%3600/60),s=seconds%60;return `${h?h+'小时':''}${m?m+'分':''}${s}秒`}
function character(value){const a=object(value),id=text(a.id??a.avatar_id??a.avatar?.id,20),known=catalog.get(id)||{};return {id,name:text(a.name??a.avatar?.name??known.name,24)||'角色资料未返回',level:num(a.level??a.avatar?.level),rarity:num(a.rarity??a.star??known.rarity),element:text(a.element??a.element_type??known.element,16),icon:publicIcon(a.icon??a.avatar_icon??a.image??a.avatar?.icon),...(a.actived_constellation_num!==undefined?{constellation:num(a.actived_constellation_num)}:{}),...(a.fetter!==undefined?{fetter:num(a.fetter)}:{})}}
function amountRows(values,max=24){return array(values,max).map(v=>{const a=object(v),name=text(a.name??a.item_name??a.item?.name,40)||'材料名称未返回';return row(name,fmt(a.num??a.count??a.cnt??a.item_num),text(a.desc??a.description,90))})}
function eventRows(values,max=30){return array(values,max).map(v=>{const a=object(v);let progress=a.status===1?'尚未开始':a.status===2?'进行中':a.is_finished===true?'已完成':'开放时间未返回';if(a.type==='ActTypeTower'&&a.tower_detail?.has_data)progress=pair(a.tower_detail.total_star,a.tower_detail.max_star)+' 星';else if(a.type==='ActTypeRoleCombat'&&a.role_combat_detail?.has_data)progress=`第 ${fmt(a.role_combat_detail.max_round_id)} 幕`;else if(a.type==='ActTypeHardChallenge'&&a.hard_challenge_detail?.is_unlock)progress=`难度 ${fmt(a.hard_challenge_detail.difficulty)}`;const timing=a.start_time||a.end_time?`${date(a.start_time)} — ${date(a.end_time)}`:num(a.countdown_seconds)!==null?`${a.status===1?'距离开启':'剩余时间'} ${duration(a.countdown_seconds)}`:'';return row(text(a.name??a.title??a.activity_name,48)||'活动名称未返回',timing?progress==='开放时间未返回'?timing:progress:progress,[timing&&progress!=='开放时间未返回'?timing:'',text(a.desc??a.description??a.subtitle,100)].filter(Boolean).join(' · '))})}
function chambers(value){return array(value,6).map(v=>{const a=object(v);return {index:num(a.index),stars:num(a.star),maxStars:num(a.max_star),battles:array(a.battles,2).map((b,i)=>({half:i===0?'上半':'下半',time:date(b.timestamp,true),characters:array(b.avatars,4).map(character)}))}})}
function periodLabel(data,period){const a=object(data);const label=period===2||period==='上期'||period==='previous'?'上期':period===1||period==='本期'||period==='current'?'本期':text(period,24);const start=a.start_time??a.start_date_time,end=a.end_time??a.end_date_time,dates=(start||end)?`${date(start)} — ${date(end)}`:'';return [label,dates].filter(Boolean).join(' · ')}
function selectedSeason(d,period){const seasons=Array.isArray(d.data)?d.data:[];return object(seasons.length?seasons[/上期/.test(period)?1:0]??{}:d)}
function push(model,title,rows){if(rows.length)model.sections.push({title,rows})}
function buildAbyss(m,d){
 m.stats=[stat('最深抵达',d.max_floor),stat('战斗次数',num(d.total_battle_times)),stat('获得星数',num(d.total_star))];
 m.rankings=[['出战次数','reveal_rank'],['最多击破数','defeat_rank'],['承受最多伤害','take_damage_rank'],['元素战技次数','normal_skill_rank'],['最强一击','damage_rank'],['元素爆发次数','energy_skill_rank']].map(([label,key])=>({label,entries:array(d[key],key==='reveal_rank'?4:1).map(a=>({...character(a),value:num(a.value)}))}));
 m.floors=array(d.floors,12).map(v=>{const a=object(v);return {index:num(a.index),stars:num(a.star),maxStars:num(a.max_star),chambers:chambers(a.levels)}});
 m.empty=m.floors.length===0&&m.rankings.every(r=>!r.entries.length);
 m.emptyMessage=m.empty?'本期暂无挑战明细':'部分字段未返回时以「—」显示';
 if(m.empty&&d.total_battle_times===0)m.emptyMessage='暂无挑战记录';
}
function buildDaily(m,d){
 m.stats=[stat('原粹树脂',pair(d.current_resin,d.max_resin),num(d.current_resin)!==null&&num(d.max_resin)!==null&&num(d.current_resin)>=num(d.max_resin)?'树脂已满':num(d.resin_recovery_time)!==null?`回满还需 ${duration(d.resin_recovery_time)}`:'恢复时间未返回'),stat('洞天宝钱',pair(d.current_home_coin,d.max_home_coin)),stat('探索派遣',pair(Array.isArray(d.expeditions)?array(d.expeditions).length:null,d.max_expedition_num))];
 push(m,'今日旅程',[row('每日委托',pair(d.finished_task_num,d.total_task_num),d.is_extra_task_reward_received===true?'额外奖励已领取':d.is_extra_task_reward_received===false?'额外奖励尚未领取':''),row('周本减半机会',pair(d.remain_resin_discount_num,d.resin_discount_num_limit)),row('参量质变仪',d.transformer?.obtained===true?(d.transformer?.recovery_time?.reached===true?'可使用':'恢复中'):d.transformer?.obtained===false?'尚未取得':'—')]);
 const e=array(d.expeditions,5);push(m,'探索派遣',e.map((a,i)=>row(`派遣队伍 ${i+1}`,a.status==='Finished'?'已完成':a.status==='Ongoing'?duration(a.remained_time):text(a.status)||'—')));
 const training=object(d.daily_task),attendance=array(training.attendance_rewards,8);if(Object.keys(training).length)push(m,'历练修远',[row('今日历练点',training.total_num??training.total_task_num),row('已完成历练',training.finished_num??training.finished_task_num),...(attendance.length?[row('已领取奖励',attendance.filter(a=>a.status==='Taken').length+'/'+attendance.length)]:[])]);
}
function buildProfile(m,d){
 const s=object(d.stats),role=object(d.role);m.nickname=text(role.nickname,32)||m.nickname;
 m.stats=[stat('活跃天数',num(s.active_day_number)),stat('获得角色数',num(s.avatar_number)),stat('成就达成数',num(s.achievement_number)),stat('深境螺旋',s.spiral_abyss)];
 push(m,'旅行足迹',[row('冒险等阶',num(role.level)),row('风神瞳',num(s.anemoculus_number)),row('岩神瞳',num(s.geoculus_number)),row('雷神瞳',num(s.electroculus_number)),row('草神瞳',num(s.dendroculus_number)),row('水神瞳',num(s.hydroculus_number)),row('火神瞳',num(s.pyroculus_number))]);
 push(m,'世界探索',array(d.world_explorations,12).map(a=>row(text(a.name,24)||'地区名称未返回',num(a.exploration_percentage)===null?'—':fmt(Number(a.exploration_percentage)/10)+'%',num(a.level)===null?'':`声望等级 ${fmt(a.level)}`)));
 push(m,'宝箱收藏',[['华丽宝箱','luxurious_chest_number'],['珍贵宝箱','precious_chest_number'],['精致宝箱','exquisite_chest_number'],['普通宝箱','common_chest_number'],['奇馈宝箱','magic_chest_number']].map(([name,key])=>row(name,num(s[key]))));
 m.characters=array(d.avatars,24).map(character);
}
function buildTheater(m,d){
 const season=selectedSeason(d,m.period),detail=object(season.detail??d.detail),s=object(detail.stat??season.stat??d.stat),schedule=object(season.schedule??d.schedule);
 if(Object.keys(schedule).length)m.period=periodLabel(schedule,/上期/.test(m.period)?'上期':/本期/.test(m.period)?'本期':'');
 m.stats=[stat('抵达幕数',num(s.max_round_id??s.max_round??s.round_id)),stat('获得勋章',Array.isArray(s.get_medal_round_list)?s.get_medal_round_list.length:num(s.medal_num)),stat('难度等级',s.difficulty_id??s.difficulty)];
 m.characters=array(s.avatar_list??detail.avatars??season.avatars,32).map(character);
 const rounds=array(detail.rounds_data??detail.rounds??season.rounds??season.round_list,12);
 push(m,'演出统计',[row('战斗总用时',battleTime(detail.fight_statisic?.total_use_time??s.total_use_time)),row('幻剧之花',num(s.coin_num)),row('支援次数',num(s.avatar_bonus_num)),row('助演次数',num(s.rent_cnt))].filter(r=>r.value!=='—'));
 push(m,'演出回顾',rounds.map(a=>({...row(a.is_tarot===true?`圣牌挑战 ${fmt(a.tarot_serial_no)}`:`第 ${fmt(a.round_id??a.index)} 幕`,a.is_get_medal===true?'勋章已取得':a.is_get_medal===false?'尚未取得勋章':'记录已返回',date(a.finish_time??a.timestamp,true)),characters:array(a.avatars,4).map(character)})));
 m.empty=!rounds.length&&!m.characters.length;m.emptyMessage='暂无演出数据';
}
function buildChallenge(m,d){
 const season=selectedSeason(d,m.period),modes=[['单人挑战',object(season.single)],['多人挑战',object(season.mp)]].filter(([,mode])=>mode.has_data!==false&&(mode.has_data===true||mode.best||mode.stat||mode.challenge||mode.challenge_list));
 const fallback=object(season.best??season);if(!modes.length)modes.push(['挑战回顾',fallback]);
 const bestMode=modes.slice().sort((a,b)=>{const aa=object(a[1].best??a[1].stat??a[1]),bb=object(b[1].best??b[1].stat??b[1]);return (num(bb.difficulty)??-1)-(num(aa.difficulty)??-1)||(num(aa.second??aa.best_time)??Infinity)-(num(bb.second??bb.best_time)??Infinity)})[0][1],s=object(bestMode.best??bestMode.stat??bestMode);
 if(season.schedule)m.period=periodLabel(season.schedule,/上期/.test(m.period)?'上期':/本期/.test(m.period)?'本期':'');
 m.stats=[stat('最高难度',s.difficulty??s.best_difficulty),stat('挑战次数',num(s.total_challenge_times??s.challenge_times)),stat('最佳用时',battleTime(s.second??s.best_time))];
 for(const [title,mode]of modes){const modeStat=object(mode.best??mode.stat??mode),challenges=firstArray(mode.challenge_list,mode.challenge,mode.challenges,mode.battles);push(m,title,array(challenges,12).map(a=>({...row(text(a.name??a.monster?.name,48)||'挑战记录',a.difficulty!==undefined?`难度 ${fmt(a.difficulty)}`:modeStat.difficulty!==undefined?`难度 ${fmt(modeStat.difficulty)}`:'难度未返回',a.second!==undefined||a.best_time!==undefined?`最佳用时 ${battleTime(a.second??a.best_time)}`:date(a.timestamp,true)),characters:array(a.teams??a.avatars,4).map(character)})))}
 m.characters=array(bestMode.avatars??s.avatar_list??season.avatars,24).map(character);m.empty=!m.sections.length&&!m.characters.length&&s.difficulty===undefined&&s.best_time===undefined&&s.second===undefined;m.emptyMessage=m.empty?'暂无挑战记录':'暂无挑战队伍明细';
}
function buildCharacters(m,d,detail){
 const values=firstArray(d.list,d.avatars,d.characters,d.avatar_list),single=object(d.avatar??d);m.characters=array(values.length?values:detail&&(single.id!==undefined||single.avatar_id!==undefined)?[single]:[],120).map(character);
 m.stats=[stat('本次返回角色',Array.isArray(d.list)||Array.isArray(d.avatars)||Array.isArray(d.characters)||Array.isArray(d.avatar_list)||m.characters.length?m.characters.length:null)];
 if(detail){const a=object(array(values,1)[0]??d.avatar??d),w=object(a.weapon??d.weapon);m.title=m.characters[0]?.name==='角色资料未返回'?'角色养成':`${m.characters[0]?.name||'角色'} · 养成`;
  push(m,'角色资料',[row('等级',num(a.level)),row('命之座',num(a.actived_constellation_num)),row('好感等级',num(a.fetter)),row('武器',w.name),row('武器等级',num(w.level)),row('精炼等阶',num(w.affix_level))]);
  push(m,'天赋',array(a.skills??d.skills,12).map(v=>row(text(v.name,32)||'天赋名称未返回',num(v.level))));
  push(m,'圣遗物',array(a.reliquaries??d.reliquaries,5).map(v=>row(text(v.name,32)||'圣遗物名称未返回',num(v.level)===null?'—':'+'+fmt(v.level),text(v.pos_name??v.set?.name,48))));
 }
 m.empty=!m.characters.length;m.emptyMessage='暂无角色资料';
}
function buildCalendar(m,d){
 const values=firstArray(d.act_list,d.activities,d.activity_list,d.list);push(m,'活动一览',eventRows(values));
 push(m,'常驻挑战',eventRows(d.fixed_act_list,12));
 const banners=firstArray(d.gacha_list,d.gacha,d.gacha_calendar);push(m,'活动祈愿',eventRows(banners,12));
 const characters=firstArray(d.avatar_list,d.avatars);m.characters=array(characters,24).map(character);m.empty=!m.sections.length&&!m.characters.length;m.emptyMessage='暂无活动日历数据';
}
function buildLedger(m,d){
 const month=object(d.month_data??d.month??d),day=object(d.day_data);m.stats=[stat('本月原石',num(month.current_primogems??month.primogems)),stat('本月摩拉',num(month.current_mora??month.mora)),stat('今日原石',num(day.current_primogems)),stat('今日摩拉',num(day.current_mora))];
 push(m,'原石来源',array(month.group_by??d.group_by,20).map(a=>row(text(a.action??a.name,32)||'来源名称未返回',fmt(a.num??a.count),num(a.percent)===null?'':fmt(a.percent)+'%')));
 if(month.last_primogems!==undefined||month.last_mora!==undefined)push(m,'上月对照',[row('上月原石',num(month.last_primogems)),row('上月摩拉',num(month.last_mora))]);
}
function buildTcg(m,d){
 m.stats=[stat('牌手等级',num(d.level)),stat('角色牌收藏',pair(d.avatar_card_num_gained??d.avatar_card_num,d.avatar_card_num_total)),stat('行动牌收藏',pair(d.action_card_num_gained??d.action_card_num,d.action_card_num_total))];
 push(m,'牌手记录',[row('胜利场次',num(d.win_num??d.total_win_num)),row('已获经验',num(d.exp??d.current_exp)),row('下级所需经验',num(d.next_level_exp))]);
}
function buildDecks(m,d){
 const decks=firstArray(d.deck_list,d.decks,d.list);m.stats=[stat('本次返回牌组',Array.isArray(d.deck_list)||Array.isArray(d.decks)||Array.isArray(d.list)?decks.length:null)];
 push(m,'我的牌组',array(decks,60).map((a,i)=>row(text(a.name??a.deck_name,32)||`牌组 ${i+1}`,a.win_num!==undefined?`${fmt(a.win_num)} 胜`:'',array(a.avatar_cards??a.avatar_card_list??a.characters,3).map(c=>text(c.name,18)).filter(Boolean).join(' · '))));
 m.empty=!decks.length;m.emptyMessage='暂无牌组数据';
}
function buildCardsCollection(m,d){
 const cards=firstArray(d.card_list,d.cards,d.list);m.stats=[stat('本次返回卡牌',Array.isArray(d.card_list)||Array.isArray(d.cards)||Array.isArray(d.list)?cards.length:null)];
 push(m,'卡牌收藏',array(cards,120).map(a=>row(text(a.name??a.card?.name,36)||'卡牌名称未返回',a.num!==undefined?`持有 ${fmt(a.num)}`:a.proficiency!==undefined?`熟练度 ${fmt(a.proficiency)}`:'已收藏',text(a.card_type??a.type_name,40))));
 m.empty=!cards.length;m.emptyMessage='暂无卡牌收藏数据';
}
function buildCompute(m,d){
 const overall=object(d.overall_consume),level=object(d.avatar_consume??d.avatar??d.level),weapon=object(d.weapon_consume??d.weapon);
 push(m,'总计所需材料',amountRows(firstArray(d.overall_consume,d.overall_consume?.list,d.total_consume,d.total_consume?.list,d.total,d.materials,d.consume,d.list),100));
 push(m,'角色培养材料',amountRows(firstArray(d.avatar_consume,d.avatar_consume?.list,level.consume,level.materials),60));
 push(m,'武器培养材料',amountRows(firstArray(d.weapon_consume,d.weapon_consume?.list,weapon.consume,weapon.materials),60));
 push(m,'天赋培养材料',amountRows(d.avatar_skill_consume,60));
 const skills=array(d.skill_consume??d.skills,12);for(const a of skills)push(m,text(a.name,32)||'天赋培养材料',amountRows(firstArray(a.consume,a.materials,a.list),30));
 if(!m.sections.length&&Object.keys(overall).length)push(m,'材料汇总',amountRows(overall.materials));m.empty=!m.sections.length;m.emptyMessage='当前未返回材料需求';
}
function buildBlueprint(m,d){
 m.title=text(d.name??d.title,40)||m.title;m.stats=[stat('方案编号',d.share_code??d.id),stat('摆设数量',num(d.furniture_count??d.furniture_num)),stat('洞天类型',d.scene_name??d.realm_name)];
 const list=firstArray(d.furniture_list,d.furnitures,d.list,d.materials);push(m,'方案摆设',amountRows(list,120));
 if(d.description)push(m,'方案说明',[row('说明',text(d.description,120))]);m.empty=!m.sections.length;m.emptyMessage='暂无可展示的方案摆设';
}
function buildCoins(m,d){
 if(m.kind==='coinBalance'){m.stats=[stat('米游币余额',num(d.points))];push(m,'账户积分',[row('数据来源','米游社官方'),row('查询方式','本人授权 · 只读查询')]);return}
 m.stats=[stat('任务总积分',num(d.total_points)),stat('已领取积分',num(d.already_received_points)),stat('今日总积分',num(d.today_total_points))];
 push(m,'今日任务',array(d.states,60).map(a=>row(`任务 ${fmt(a.mission_id)}`,a.is_get_award===true?'奖励已领取':a.is_get_award===false?'奖励未领取':'奖励状态未返回',`进度 ${fmt(a.process)}`)));
 push(m,'查询说明',[row('只读查询','显示官方任务状态','不执行签到、点赞、分享、兑换或领奖。')]);
}

export function buildRecordModel(kind,data,{uid,nickname,period}={}){
 if(!supportsRecordKind(kind))throw new TypeError('UNSUPPORTED_RECORD_KIND');
 const d=object(data),m={kind,title:TITLES[kind],theme:NIGHT.has(kind)?'night':'cream',uid:uidText(uid),nickname:text(nickname,32),period:periodLabel(d,period),stats:[],sections:[],characters:[],rankings:[],floors:[],empty:false,emptyMessage:''};
 if(kind==='spiralAbyss')buildAbyss(m,d);else if(kind==='dailyNote')buildDaily(m,d);else if(kind==='index')buildProfile(m,d);else if(kind==='role_combat')buildTheater(m,d);else if(kind==='hard_challenge')buildChallenge(m,d);else if(kind==='character'||kind==='detail')buildCharacters(m,d,kind==='detail');else if(kind==='act_calendar')buildCalendar(m,d);else if(kind==='ledger')buildLedger(m,d);else if(kind==='gcg/basicInfo')buildTcg(m,d);else if(kind==='deckList')buildDecks(m,d);else if(kind==='tcgCards')buildCardsCollection(m,d);else if(kind==='compute')buildCompute(m,d);else if(kind==='blueprint')buildBlueprint(m,d);else if(kind==='coinBalance'||kind==='coinMissions')buildCoins(m,d);else if(kind==='blueprintCompute'){push(m,'家具所需材料',amountRows(firstArray(d.materials,d.material_list,d.list,d.consume),120));m.empty=!m.sections.length;m.emptyMessage='当前未返回家具材料需求'}
 return m;
}

export function buildRecordText(model){
 const m=model?.model??model;if(!m||!supportsRecordKind(m.kind))throw new TypeError('UNSUPPORTED_RECORD_KIND');
 const lines=[m.title,...(m.nickname?[m.nickname]:[]),...(m.period?[m.period]:[]),...m.stats.map(s=>`${s.label}：${s.value}${s.detail?'（'+s.detail+'）':''}`)];
 for(const ranking of m.rankings)if(ranking.entries.length)lines.push(`${ranking.label}：`+ranking.entries.map(a=>`${a.name} ${fmt(a.value)}`).join('、'));
 for(const section of m.sections)lines.push(section.title,...section.rows.map(r=>`${r.label}：${r.value}${r.detail?' · '+r.detail:''}${r.characters?.length?'\n队伍：'+r.characters.map(a=>`${a.name}${a.level===null?'':' Lv.'+a.level}`).join('、'):''}`));
 if(m.characters.length)lines.push('角色：'+m.characters.map(c=>`${c.name}${c.level===null?'':' Lv.'+c.level}`).join('、'));
 for(const f of m.floors){lines.push(`深境螺旋第 ${fmt(f.index)} 层 · 星数 ${pair(f.stars,f.maxStars)}`);for(const c of f.chambers){lines.push(`第 ${fmt(c.index)} 间 · 星数 ${pair(c.stars,c.maxStars)}`);for(const b of c.battles)lines.push(`${b.half} ${b.time}：${b.characters.map(a=>`${a.name}${a.level===null?'':' Lv.'+a.level}`).join('、')||'队伍资料未返回'}`)}}
 if(m.empty)lines.push(m.emptyMessage||'暂无记录');return lines.join('\n');
}

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const CREAM={bg:'#f5f0e8',panel:'#fffdf8',panel2:'#eee5d7',ink:'#3b4050',muted:'#8b7b66',gold:'#b39762',line:'#d9c9ac',hero:'#3d5260',accent:'#c3a474'};
const NIGHT_COLORS={bg:'#10132c',panel:'#22233f',panel2:'#30304f',ink:'#f5f0e1',muted:'#b0b0c9',gold:'#dbc68e',line:'#5e5476',hero:'#171b37',accent:'#aaa0de'};
const t=(x,y,value,size=24,fill='#fff',weight=400,anchor='start')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(value)}</text>`;
const rect=(x,y,w,h,fill,rx=18,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>`;
function fit(value,width,size){const source=String(value??''),chars=Array.from(source),cost=char=>/[\x20-\x7e]/.test(char)?size*.57:size;if(chars.reduce((n,char)=>n+cost(char),0)<=width)return source;let out='',used=0;for(const char of chars){const next=cost(char);if(used+next>width-size)return out+'…';out+=char;used+=next}return out}
function wrap(value,max=34,lines=2){const chars=Array.from(text(value,max*lines+1));const out=[];for(let i=0;i<chars.length&&out.length<lines;i+=max)out.push(chars.slice(i,i+max).join(''));if(chars.length>max*lines)out[lines-1]=out[lines-1].slice(0,-1)+'…';return out.length?out:['—']}
function lines(x,y,value,max=32,size=23,fill='#fff',count=2){return wrap(value,max,count).map((v,i)=>t(x,y+i*(size+9),v,size,fill)).join('')}
function diamond(x,y,size,fill){return `<path d="M${x} ${y-size} L${x+size*.62} ${y} L${x} ${y+size} L${x-size*.62} ${y}Z" fill="${fill}"/>`}
function sectionTitle(y,title,c,sub=''){return diamond(64,y-8,12,c.gold)+t(90,y,fit(title,sub?680:900,30),30,c.ink,650)+(sub?t(1016,y,fit(sub,250,19),19,c.muted,400,'end'):'')}
function frame(x,y,w,h,c){return rect(x,y,w,h,c.panel,22,c.line)+`<path d="M${x+14} ${y+48}V${y+27}Q${x+27} ${y+27} ${x+27} ${y+14}H${x+70} M${x+w-70} ${y+14}H${x+w-27}Q${x+w-27} ${y+27} ${x+w-14} ${y+27}V${y+48} M${x+14} ${y+h-48}V${y+h-27}Q${x+27} ${y+h-27} ${x+27} ${y+h-14}H${x+70} M${x+w-70} ${y+h-14}H${x+w-27}Q${x+w-27} ${y+h-27} ${x+w-14} ${y+h-27}V${y+h-48}" fill="none" stroke="${c.gold}" stroke-opacity=".5"/>`}
function nativeImage(value){if(typeof value!=='string'||value.length>350000)return '';const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match||match[2].length%4)return '';const bytes=Buffer.from(match[2],'base64');if(bytes.toString('base64')!==match[2]||bytes.length>256*1024)return '';return (match[1]==='png'?bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.length>=12&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217)?value:''}
function avatar(a,x,y,w,h,c,assets,compact=false){
 const picture=nativeImage(assets?.avatars?.[a.id]),portraitH=h-(compact?43:58),name=Array.from(a.name).slice(0,w<110?5:8).join('');
 const color=a.rarity===5?'#bd9869':a.rarity===4?'#887baf':c.accent;
 let out=rect(x,y,w,h,c.panel2,13,c.line)+rect(x+2,y+2,w-4,portraitH,color,11);
 if(picture)out+=`<image x="${x+2}" y="${y+2}" width="${w-4}" height="${portraitH}" href="${esc(picture)}" preserveAspectRatio="xMidYMid slice"/>`;
 else out+=`<circle cx="${x+w/2}" cy="${y+portraitH*.39}" r="${w*.16}" fill="#fff" opacity=".48"/><path d="M${x+w*.2} ${y+portraitH*.89}Q${x+w*.5} ${y+portraitH*.37} ${x+w*.8} ${y+portraitH*.89}" fill="#fff" opacity=".35"/>`+diamond(x+w*.83,y+18,7,'#fff3cf');
 out+=t(x+w/2,y+portraitH+22,name,compact?16:19,c.ink,550,'middle');
 if(!compact)out+=t(x+w/2,y+h-11,a.level===null?'等级未返回':'Lv.'+fmt(a.level),17,c.muted,500,'middle');
 else out+=t(x+w-7,y+18,a.level===null?'':'Lv.'+fmt(a.level),13,'#fff',600,'end');
 return out;
}
function header(m,c,subtitle=''){
 let out=rect(0,0,1080,250,'url(#hero)',0)+`<g opacity=".12" fill="none" stroke="${c.gold}" stroke-width="2"><circle cx="950" cy="75" r="210"/><circle cx="950" cy="75" r="170"/><circle cx="950" cy="75" r="125"/><path d="M730 75h440M950-145v440M794-81l312 312M794 231l312-312"/></g>`;
 out+=t(58,55,'GENSHIN  /  TRAVEL CHRONICLE',16,'#d7c496',550)+diamond(1015,48,13,'#e6d1a0');
 out+=t(58,124,fit(m.title,950,48),48,'#fff8e8',650)+t(60,173,fit([m.nickname||'旅行者',m.uid?'UID '+m.uid:''].filter(Boolean).join('  ·  '),950,23),23,'#e4e0d8');
 out+=t(60,215,subtitle||m.period||'来自本人授权的游戏记录',20,'#cbc9d4');return out;
}
function footer(y,m,c,page,total,truncated){return `<path d="M58 ${y-20}H1022" stroke="${c.line}"/>`+t(58,y+13,'✦ 原神助手 · 旅途常新',17,c.muted,500)+t(1022,y+13,`${truncated?'篇幅有限，完整资料请用「文字」 · ':''}${page} / ${total}`,16,c.muted,400,'end')}
function statsBlock(m,y,c){
 const stats=m.stats.slice(0,4);if(!stats.length)return {svg:'',height:0};const w=(964-(stats.length-1)*16)/stats.length;let out='';
 stats.forEach((s,i)=>{const x=58+i*(w+16),base=stats.length>3?32:38,units=Array.from(s.value).reduce((n,char)=>n+(/[\x20-\x7e]/.test(char)?.57:1),0),font=Math.max(18,Math.min(base,Math.floor((w-40)/Math.max(1,units))));out+=rect(x,y,w,137,c.panel,17,c.line)+t(x+20,y+39,fit(s.label,w-40,20),20,c.muted,500)+t(x+20,y+87,fit(s.value,w-40,font),font,c.ink,650)+(s.detail?t(x+20,y+116,fit(s.detail,w-40,15),15,c.muted):'')});return {svg:out,height:163};
}
function emptyBlock(y,m,c){const detail=m.kind==='spiralAbyss'||m.kind==='hard_challenge'?'该周期尚无可展示的战斗明细。':m.kind==='role_combat'?'该周期尚无可展示的演出明细。':'当前记录尚未包含可展示的明细。';return {svg:frame(58,y,964,306,c)+`<circle cx="540" cy="${y+100}" r="51" fill="${c.panel2}"/>`+diamond(540,y+100,32,c.gold)+t(540,y+205,m.emptyMessage||'暂无记录',31,c.ink,550,'middle')+t(540,y+250,detail,20,c.muted,400,'middle'),height:334}}
function renderAbyssSummary(m,c,assets){
 let y=286,out='';const stats=statsBlock(m,y,c);out+=stats.svg;y+=stats.height;
 out+=sectionTitle(y+27,'挑战回顾',c,m.period?'官方记录':'');y+=52;
 if(m.empty){const empty=emptyBlock(y,m,c);out+=empty.svg;y+=empty.height}
 else {
  const reveal=m.rankings.find(r=>r.label==='出战次数'),others=m.rankings.filter(r=>r!==reveal);
  out+=frame(58,y,964,495,c);
  out+=t(88,y+52,'出战次数',24,c.gold,600);const e=reveal?.entries||[];
  if(e.length)e.forEach((a,i)=>{out+=avatar(a,90+i*106,y+77,94,134,c,assets,true)+t(137+i*106,y+240,fmt(a.value),24,c.ink,650,'middle')});else out+=t(90,y+130,'出战角色资料未返回',20,c.muted);
  out+=`<path d="M530 ${y+40}V${y+455}" stroke="${c.line}"/>`;
  others.forEach((r,i)=>{const yy=y+71+i*77,a=r.entries[0];out+=t(562,yy,r.label,21,c.muted)+t(984,yy+30,a?fmt(a.value):'—',27,c.ink,650,'end');if(a)out+=t(562,yy+30,a.name,18,c.ink)});y+=525;
 }
 return {body:out,height:y+80};
}
function renderFloors(m,floors,c,assets){
 let y=286,out='';for(const f of floors){out+=sectionTitle(y+28,`深境螺旋第 ${fmt(f.index)} 层`,c,`✦ ${pair(f.stars,f.maxStars)}`);y+=52;
  if(!f.chambers.length){out+=frame(58,y,964,150,c)+t(90,y+85,'该层尚无战斗明细',24,c.muted);y+=180;continue}
  const blockHeight=f.chambers.reduce((h,ch)=>h+100+Math.max(1,ch.battles.length)*190,24)+20;out+=frame(58,y,964,blockHeight,c);let cy=y+48;
  f.chambers.forEach((ch,index)=>{if(index)out+=`<path d="M91 ${cy-20}H989" stroke="${c.line}"/>`;
   out+=t(90,cy+10,`第 ${fmt(ch.index)} 间`,27,c.gold,650)+t(985,cy+10,`✦ ${pair(ch.stars,ch.maxStars)}`,26,c.ink,650,'end');cy+=52;
   if(!ch.battles.length){out+=rect(88,cy,902,146,c.panel2,15)+t(118,cy+79,'该间队伍与挑战时间未返回',23,c.muted);cy+=190}
   for(const b of ch.battles){out+=rect(88,cy,902,164,c.panel2,15)+t(912,cy+62,b.half,27,c.ink,650,'middle')+t(912,cy+99,b.time==='—'?'时间未返回':b.time.slice(0,10),14,c.muted,400,'middle')+(b.time==='—'?'':t(912,cy+126,b.time.slice(11),17,c.muted,500,'middle'));
    if(b.characters.length)b.characters.forEach((a,i)=>{out+=avatar(a,108+i*168,cy+13,145,138,c,assets,true)});else out+=t(118,cy+85,'队伍角色资料未返回',23,c.muted);cy+=190;
   }cy+=48;
  });y+=blockHeight+36;
 }return {body:out,height:y+80};
}
const rowHeight=r=>(r.detail?102:78)+(r.characters?.length?178:0);
function rowSection(section,y,c,assets){
 const heights=section.rows.map(rowHeight),height=heights.reduce((a,b)=>a+b,0)+30;let out=sectionTitle(y+27,section.title,c);y+=51;out+=frame(58,y,964,height,c);let cy=y+22;
 section.rows.forEach((r,i)=>{if(i)out+=`<path d="M88 ${cy-9}H992" stroke="${c.line}"/>`;out+=t(90,cy+30,fit(r.label,428,23),23,c.ink,550)+t(986,cy+30,fit(r.value,438,23),23,c.gold,600,'end');if(r.detail)out+=t(90,cy+66,fit(r.detail,890,18),18,c.muted);if(r.characters?.length)r.characters.slice(0,4).forEach((a,j)=>{out+=avatar(a,92+j*220,cy+(r.detail?84:57),192,158,c,assets,true)});cy+=heights[i]});return {svg:out,height:height+78};
}
function renderGeneral(m,parts,c,assets,withStats){
 let out='',y=286;if(withStats){const b=statsBlock(m,y,c);out+=b.svg;y+=b.height}
 for(const part of parts){if(part.characters){out+=sectionTitle(y+26,'角色一览',c);y+=53;const h=Math.ceil(part.characters.length/6)*208+36;out+=frame(58,y,964,h,c);part.characters.forEach((a,i)=>{out+=avatar(a,86+(i%6)*154,y+24+Math.floor(i/6)*208,138,181,c,assets)});y+=h+30}
 else {const section=rowSection(part,y,c,assets);out+=section.svg;y+=section.height}}
 if(!parts.length){const e=emptyBlock(y,{...m,emptyMessage:m.emptyMessage||'暂无可展示的记录'},c);out+=e.svg;y+=e.height}
 return {body:out,height:y+80};
}
function shell(m,body,height,c,index,total,truncated){
 const h=Math.ceil(height);return {svg:`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${h}" viewBox="0 0 1080 ${h}"><defs><linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${c.hero}"/><stop offset="1" stop-color="${m.theme==='night'?'#292144':'#596772'}"/></linearGradient></defs><g font-family="Microsoft YaHei,Noto Sans CJK SC,Arial,sans-serif">${rect(0,0,1080,h,c.bg,0)}${header(m,c,index>1?`${m.period||'本人游戏记录'} · ${m.kind==='spiralAbyss'?'挑战详情':'记录续页'}`:'')}${body}${footer(h-46,m,c,index,total,truncated)}</g></svg>`,width:1080,height:h,private:true,title:m.title+(total>1?` · ${index}/${total}`:'')};
}

/** The renderer accepts only escaped native SVG. The optional avatar map is
 * populated by the caller's public-asset resolver; API image URLs never enter SVG. */
export function buildRecordCards(card,{assets={}}={}){
 const input=card?.model??card,m=input?.stats&&input?.sections?input:buildRecordModel(input?.kind,input?.data,input||{});
 if(!m||!supportsRecordKind(m.kind))throw new TypeError('UNSUPPORTED_RECORD_KIND');
 const c=m.theme==='night'?NIGHT_COLORS:CREAM,pages=[];let truncated=false;
 if(m.kind==='spiralAbyss'){
  pages.push(renderAbyssSummary(m,c,assets));
  for(let i=0;i<m.floors.length;i+=2){if(pages.length===8){truncated=true;break}pages.push(renderFloors(m,m.floors.slice(i,i+2),c,assets))}
 }else{
  const parts=[];if(m.characters.length)for(let i=0;i<m.characters.length;i+=18)parts.push({characters:m.characters.slice(i,i+18)});
  for(const section of m.sections){const pageSize=section.rows.some(r=>r.characters?.length)?6:12;for(let i=0;i<section.rows.length;i+=pageSize)parts.push({title:section.title+(i?' · 续':''),rows:section.rows.slice(i,i+pageSize)})}
  let selected=[],weight=0;for(const part of parts){const w=part.characters?Math.ceil(part.characters.length/6)*208+130:part.rows.reduce((n,r)=>n+rowHeight(r),0)+110;if(selected.length&&weight+w>2050){pages.push(renderGeneral(m,selected,c,assets,pages.length===0));selected=[];weight=0}if(pages.length===8){truncated=true;break}selected.push(part);weight+=w}
  if(selected.length&&pages.length<8)pages.push(renderGeneral(m,selected,c,assets,pages.length===0));if(!pages.length)pages.push(renderGeneral(m,[],c,assets,true));
 }
 return pages.map((page,i)=>shell(m,page.body,page.height,c,i+1,pages.length,truncated));
}
