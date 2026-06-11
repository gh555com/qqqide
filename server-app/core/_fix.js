var fs=require('fs');  
var c=fs.readFileSync('editor.js','utf8');  
var lines=c.split('\n');  
var i=424; var l=lines[i]; var "pos=l.indexOf('    if (');" if(pos>=0) { var indent=l.substring(0,l.search(/\\S/)); lines[i]=l.substring(0,pos).trimEnd(); lines.splice(i+1,0,indent+l.substring(pos).trimStart()); }  
i=462; l=lines[i]; "pos=l.indexOf('      configureMonaco');" if(pos>=0) { var indent=l.substring(0,l.search(/\\S/)); lines[i]=l.substring(0,pos).trimEnd(); lines.splice(i+1,0,indent+'configureMonacoTypescript(monaco);'); }  
i=542; l=lines[i]; "pos=l.indexOf('      ed.onDidDispose');" if(pos>=0) { var indent=l.substring(0,l.search(/\\S/)); lines[i]=l.substring(0,pos).trimEnd(); "lines.splice(i+1,0,indent+'ed.onDidDispose(function () {');" }  
i=769; l=lines[i]; "pos=l.indexOf('        var idx');" if(pos>=0) { var indent=l.substring(0,l.search(/\\S/)); lines[i]=l.substring(0,pos).trimEnd(); "lines.splice(i+1,0,indent+'var idx = _allMonacoEditors.indexOf(ed);');" }  
fs.writeFileSync('editor.js',lines.join('\n')); console.log('Fixed');  
