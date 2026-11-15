import type {PdfReviewManifest} from './pdfReviewTypes';
function jsString(value: string) {return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');}
/** Exported for deterministic script validation; importing a PDF never runs this script. */
export function pdfReviewMenuScript(manifest: PdfReviewManifest): string {
  const fields = manifest.entries.map(entry => 'RRDecision_' + manifest.exportId + '_' + entry.id);
  const reasons = manifest.entries.map(entry => entry.reason ?? manifest.request.request[entry.index]!.reason ?? '');
  return 'var RRReviewFields=' + JSON.stringify(fields) + ';\nvar RRReviewReasons=[' + reasons.map(jsString).join(',') + '];\n' +
    'function RRReviewMenu(index){\n' +
    ' var choice=null;\n' +
    ' if(typeof app.popUpMenuEx==="function") choice=app.popUpMenuEx({cName:"Why",cReturn:"why"},{cName:"Accept all up to here",cReturn:"accept"});\n' +
    ' else if(typeof app.popUpMenu==="function") choice=app.popUpMenu("Why","Accept all up to here");\n' +
    ' else {app.alert("This PDF viewer does not support the review menu. Accept/Ignore still work. The explanation is in the note beside this change.");return;}\n' +
    ' if(choice==="why"||choice==="Why") app.alert(RRReviewReasons[index]||"No explanation provided.");\n' +
    ' if(choice==="accept"||choice==="Accept all up to here"){\n' +
    '  for(var i=0;i<=index;i++){var field=this.getField(RRReviewFields[i]);if(field&&(field.value==="Off"||field.value===""||field.value===null))field.value="accepted";}\n' +
    ' }\n}\n';
}
