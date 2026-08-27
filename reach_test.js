const Game=require("./replays/Game");const {GameState}=require("./src/gamestate");
const {Strategy}=require("./src/strategy");const {injectView,loadReplays}=require("./arena");
let reachSum=0,maxSum=0,n=0,land=0;
for(const r of loadReplays().slice(0,20)){
 const game=Game.createFromReplay(r);
 const gs=new GameState();gs.start({playerIndex:0,replay_id:"r",usernames:["A","B"],teams:undefined});
 const gsO=new GameState();gsO.start({playerIndex:1,replay_id:"r",usernames:["A","B"],teams:undefined});
 const bot=new Strategy(gs);const opp=new Strategy(gsO);
 const gt=r.generals[0],W=r.mapWidth,gr=(gt/W)|0,gc=gt%W;
 while(!game.isOver()&&game.turn<110){
  injectView(gs,game,0);let a=null;try{a=bot.nextMove();}catch(e){}if(a)game.inputBuffer[0].push([a.from,a.to,!!a.is50]);
  injectView(gsO,game,1);let b=null;try{b=opp.nextMove();}catch(e){}if(b)game.inputBuffer[1].push([b.from,b.to,!!b.is50]);
  game.update();
  if(game.turn===100){let sum=0,mx=0,cnt=0;for(let t=0;t<game.map.size();t++){if(game.map.tileAt(t)===0){const d=Math.abs(((t/W)|0)-gr)+Math.abs((t%W)-gc);sum+=d;mx=Math.max(mx,d);cnt++;}}reachSum+=sum/cnt;maxSum+=mx;land+=cnt;n++;}
 }
}
console.log(`REACH_W=${process.env.REACH_W}: t50平均触角 ${(reachSum/n).toFixed(1)}  最远 ${(maxSum/n).toFixed(1)}  地块 ${(land/n).toFixed(1)}`);
