export class PaperEngine{
constructor(balance){this.balance=balance;this.position=null;this.trades=[];}
open(side,price,atr,settings){
const margin=this.balance*(settings.riskPercent/100);
const size=margin*settings.leverage;
this.position={side,entry:price,size,
sl:side==='LONG'?price-atr*settings.stopATR:price+atr*settings.stopATR,
tp:side==='LONG'?price+atr*settings.tpATR:price-atr*settings.tpATR};
}
check(price){
if(!this.position)return;
const p=this.position;
let exit=false;
if(p.side==='LONG'&&(price<=p.sl||price>=p.tp)) exit=true;
if(p.side==='SHORT'&&(price>=p.sl||price<=p.tp)) exit=true;
if(exit){
const pnl=(p.side==='LONG'?(price-p.entry):(p.entry-price))*p.size/p.entry;
this.balance+=pnl;
this.trades.push({side:p.side,pnl,time:new Date().toISOString()});
this.position=null;
}
}}