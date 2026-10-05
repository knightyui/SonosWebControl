export const searchPageSize=30;

export function parseSearchPage(value){
  const page=Number(value??1);
  if(!Number.isInteger(page)||page<1||page>1000)throw Error('搜索页码无效。');
  return page;
}

export function hasMoreSearchResults(page,total,received){
  return received===searchPageSize&&(!Number.isFinite(total)||total<=0||page*searchPageSize<total);
}
