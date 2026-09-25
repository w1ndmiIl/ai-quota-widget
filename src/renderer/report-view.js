"use strict";
(function (root, factory) {
  const api = factory(); if (typeof module === "object" && module.exports) module.exports = api; if (root) root.ReportView = api;
})(typeof window === "undefined" ? null : window, () => {
  const key = (date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  function series(report) {
    let values;
    if (report.range.days <= 1) values = report.history.hourly.map((item) => ({ value: item.total || 0, label: new Date(item.t).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", hour12:false }), fullLabel: new Date(item.t).toLocaleString() }));
    else {
      const keys = Object.keys(report.history.daily).sort();
      const start = new Date(report.range.preset === "all" && keys.length ? keys[0] + "T00:00:00" : report.range.start);
      const end = new Date(report.range.end); start.setHours(0,0,0,0); end.setHours(0,0,0,0);
      const monthly = (end-start)/86400000 > 366;
      const totals = new Map();
      for (const [day, usage] of Object.entries(report.history.daily)) { const period=monthly?day.slice(0,7):day; totals.set(period,(totals.get(period)||0)+(usage.total||0)); }
      if(monthly) start.setDate(1);
      values=[];
      for(const date=new Date(start);date<=end;monthly?date.setMonth(date.getMonth()+1):date.setDate(date.getDate()+1)) {
        const period=monthly?key(date).slice(0,7):key(date);
        values.push({value:totals.get(period)||0,label:monthly?period:period.slice(5),fullLabel:period});
      }
    }
    return values.map((item,index)=>({...item,x:values.length<2?0.5:index/(values.length-1)}));
  }
  return { series };
});
