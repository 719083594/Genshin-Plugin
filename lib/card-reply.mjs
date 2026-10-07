/** Adapter-only image delivery. A view never replaces authentication checks. */
export class CardReplyError extends Error{
 constructor(sent,total,cause){super('CARD_REPLY_INCOMPLETE',{cause});this.name='CardReplyError';this.sent=sent;this.total=total;}
}
export async function sendCardReply(result,{event,buildCards,render,image}={}){
 if(!result?.card)return false;
 if(result.card.private===true&&(event?.group_id||event?.isGroup===true||event?.privateChat===false))throw new Error('PRIVATE_CARD_ONLY');
 const cards=await buildCards(result.card);
 if(!Array.isArray(cards)||!cards.length||cards.length>8)throw new Error('INVALID_CARD_COUNT');
 let sent=0;
 try{for(const card of cards){
   const bytes=await render({...card,private:result.card.private===true});
   if(!Buffer.isBuffer(bytes))throw new Error('INVALID_CARD_IMAGE');
   await event.reply(image(bytes));sent++;
 }}catch(error){if(sent)throw new CardReplyError(sent,cards.length,error);throw error;}
 return true;
}
