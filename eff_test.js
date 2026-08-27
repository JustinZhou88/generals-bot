const Game=require("./replays/Game");const {GameState}=require("./src/gamestate");
const {Strategy}=require("./src/strategy");const {injectView,loadReplays}=require("./arena");
let retread=0, moves=0, transit1=0;
for(const r of loadReplays().slice(0,15)){
  const game=Game.createFromReplay(r);
  const gs=new GameState();gs.start({playerIndex:0,replay_id:"e",usernames:["A","B"],teams:undefined});
  const gsO=new GameState();gsO.start({playerIndex:1,replay_id:"e",usernames:["A","B"],teams:undefined});
  const bot=new Strategy(gs);const opp=new Strategy(gsO);
  const recentFrom=[];
  while(!game.isOver()&&game.turn<500){
    injectView(gs,game,0);let a=null;try{a=bot.nextMove();}catch(e){}
    injectView(gsO,game,1);let b=null;try{b=opp.nextMove();}catch(e){}
    if(a){moves++;
      if(recentFrom.includes(a.to))retread++;
      if(gs.terrain[a.to]===0 && gs.armies[a.to]<=1)transit1++;
      recentFrom.push(a.from);if(recentFrom.length>8)recentFrom.shift();
      game.inputBuffer[0].push([a.from,a.to,!!a.is50]);
    }
    if(b)game.inputBuffer[1].push([b.from,b.to,!!b.is50]);
    game.update();
  }
}
console.log(`  总步数${moves}  回头重复走 ${(retread/moves*100).toFixed(1)}%  落到自己1兵地 ${(transit1/moves*100).toFixed(1)}%`);
