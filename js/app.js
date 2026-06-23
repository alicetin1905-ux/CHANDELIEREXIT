import {SETTINGS} from './config.js';
import {loadHistory,connect} from './bybit.js';
import {PaperEngine} from './paperEngine.js';
import {evaluate} from './strategy.js';

const chart=LightweightCharts.createChart(document.getElementById('chart'));
const series=chart.addCandlestickSeries();
const engine=new PaperEngine(SETTINGS.balance);
let candles=[];

function render(){
document.getElementById('balance').textContent=engine.balance.toFixed(2);
document.getElementById('position').textContent=engine.position?.side||'NONE';
const tb=document.querySelector('#trades tbody');
tb.innerHTML=engine.trades.map(t=>`<tr><td>${t.time}</td><td>${t.side}</td><td>${t.pnl.toFixed(2)}</td></tr>`).join('');
}

loadHistory().then(data=>{
candles=data; series.setData(candles); evaluate(candles,engine,SETTINGS); render();
connect(k=>{
const c={time:Math.floor(+k.start/1000),open:+k.open,high:+k.high,low:+k.low,close:+k.close};
candles.push(c); series.update(c);
document.getElementById('price').textContent=c.close;
evaluate(candles,engine,SETTINGS); render();
});
});