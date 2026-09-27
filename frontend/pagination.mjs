export const PRODUCTS_PER_PAGE=12;
export function productPage(products,page=0){const pages=Math.max(1,Math.ceil(products.length/PRODUCTS_PER_PAGE));const index=Math.max(0,Math.min(pages-1,page));return {items:products.slice(index*PRODUCTS_PER_PAGE,(index+1)*PRODUCTS_PER_PAGE),index,pages};}
