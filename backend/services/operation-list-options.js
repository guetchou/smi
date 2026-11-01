'use strict';
const columns=Object.freeze({date:'o.date',reference:'o.num_piece',libelle:'o.libelle',compte:'p.libelle',montant:'o.montant'});
function operationSort(query={}){return {column:Object.hasOwn(columns,query.sort)?columns[query.sort]:columns.date,direction:query.order==='ASC'?'ASC':'DESC'};}
module.exports={operationSort};
