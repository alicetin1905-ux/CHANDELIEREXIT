export async function loadHistory(){
const r=await fetch('https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=30&limit=200');
const j=await r.json();
return j.result.list.reverse().map(x=>({
time:Math.floor(+x[0]/1000),open:+x[1],high:+x[2],low:+x[3],close:+x[4]
}));
}
export function connect(onClose){
const ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');
ws.onopen=()=>ws.send(JSON.stringify({op:'subscribe',args:['kline.30.BTCUSDT']}));
ws.onmessage=e=>{
const m=JSON.parse(e.data);
if(m.data&&m.data[0].confirm) onClose(m.data[0]);
};
}