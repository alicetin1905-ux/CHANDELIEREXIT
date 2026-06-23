import {zlsma,atr} from './indicators.js';
export function evaluate(candles,engine,settings){
const z=zlsma(candles,settings.zlsmaLength);
const a=atr(candles,settings.chandelierATR);
if(!z||!a)return;
const last=candles.at(-1);
engine.check(last.close);
if(engine.position) return;
if(last.close>z) engine.open('LONG',last.close,a,settings);
if(last.close<z) engine.open('SHORT',last.close,a,settings);
}