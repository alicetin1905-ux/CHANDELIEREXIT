export function sma(arr,n){
if(arr.length<n)return null;
return arr.slice(-n).reduce((a,b)=>a+b.close,0)/n;
}
export const zlsma=sma;
export function atr(data,n=4){
if(data.length<n+1)return null;
let trs=[];
for(let i=data.length-n;i<data.length;i++){
const c=data[i],p=data[i-1];
trs.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
}
return trs.reduce((a,b)=>a+b,0)/trs.length;
}