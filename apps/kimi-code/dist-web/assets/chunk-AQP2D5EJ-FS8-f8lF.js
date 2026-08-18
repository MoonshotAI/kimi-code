import{g as Zt}from"./chunk-55IACEB6-B5dE1-Um.js";import{s as te}from"./chunk-2J33WTMH-w4sdiKFO.js";import{_ as f,l as _,c as w,r as ee,u as se,a as ie,b as re,g as ae,s as ne,p as oe,q as le,T as ce,k as W,z as he}from"./mermaidParser.worker-Dx4jPi9z.js";var Dt=(function(){var t=f(function(Y,a,c,r){for(c=c||{},r=Y.length;r--;c[Y[r]]=a);return c},"o"),e=[1,2],l=[1,3],s=[1,4],u=[2,4],d=[1,9],S=[1,11],g=[1,16],n=[1,17],T=[1,18],m=[1,19],N=[1,33],A=[1,20],k=[1,21],h=[1,22],x=[1,23],D=[1,24],$=[1,26],L=[1,27],P=[1,28],I=[1,29],J=[1,30],st=[1,31],it=[1,32],rt=[1,35],at=[1,36],nt=[1,37],ot=[1,38],j=[1,34],p=[1,4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],lt=[1,4,5,14,15,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,39,40,41,45,48,51,52,53,54,57],At=[4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],yt={trace:f(function(){},"trace"),yy:{},symbols_:{error:2,start:3,SPACE:4,NL:5,SD:6,document:7,line:8,statement:9,classDefStatement:10,styleStatement:11,cssClassStatement:12,idStatement:13,DESCR:14,"-->":15,HIDE_EMPTY:16,scale:17,WIDTH:18,COMPOSIT_STATE:19,STRUCT_START:20,STRUCT_STOP:21,STATE_DESCR:22,AS:23,ID:24,FORK:25,JOIN:26,CHOICE:27,CONCURRENT:28,note:29,notePosition:30,NOTE_TEXT:31,direction:32,acc_title:33,acc_title_value:34,acc_descr:35,acc_descr_value:36,acc_descr_multiline_value:37,CLICK:38,STRING:39,HREF:40,classDef:41,CLASSDEF_ID:42,CLASSDEF_STYLEOPTS:43,DEFAULT:44,style:45,STYLE_IDS:46,STYLEDEF_STYLEOPTS:47,class:48,CLASSENTITY_IDS:49,STYLECLASS:50,direction_tb:51,direction_bt:52,direction_rl:53,direction_lr:54,eol:55,";":56,EDGE_STATE:57,STYLE_SEPARATOR:58,left_of:59,right_of:60,$accept:0,$end:1},terminals_:{2:"error",4:"SPACE",5:"NL",6:"SD",14:"DESCR",15:"-->",16:"HIDE_EMPTY",17:"scale",18:"WIDTH",19:"COMPOSIT_STATE",20:"STRUCT_START",21:"STRUCT_STOP",22:"STATE_DESCR",23:"AS",24:"ID",25:"FORK",26:"JOIN",27:"CHOICE",28:"CONCURRENT",29:"note",31:"NOTE_TEXT",33:"acc_title",34:"acc_title_value",35:"acc_descr",36:"acc_descr_value",37:"acc_descr_multiline_value",38:"CLICK",39:"STRING",40:"HREF",41:"classDef",42:"CLASSDEF_ID",43:"CLASSDEF_STYLEOPTS",44:"DEFAULT",45:"style",46:"STYLE_IDS",47:"STYLEDEF_STYLEOPTS",48:"class",49:"CLASSENTITY_IDS",50:"STYLECLASS",51:"direction_tb",52:"direction_bt",53:"direction_rl",54:"direction_lr",56:";",57:"EDGE_STATE",58:"STYLE_SEPARATOR",59:"left_of",60:"right_of"},productions_:[0,[3,2],[3,2],[3,2],[7,0],[7,2],[8,2],[8,1],[8,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,3],[9,4],[9,1],[9,2],[9,1],[9,4],[9,3],[9,6],[9,1],[9,1],[9,1],[9,1],[9,4],[9,4],[9,1],[9,2],[9,2],[9,1],[9,5],[9,5],[10,3],[10,3],[11,3],[12,3],[32,1],[32,1],[32,1],[32,1],[55,1],[55,1],[13,1],[13,1],[13,3],[13,3],[30,1],[30,1]],performAction:f(function(a,c,r,y,E,i,F){var o=i.length-1;switch(E){case 3:return y.setRootDoc(i[o]),i[o];case 4:this.$=[];break;case 5:i[o]!="nl"&&(i[o-1].push(i[o]),this.$=i[o-1]);break;case 6:case 7:this.$=i[o];break;case 8:this.$="nl";break;case 12:this.$=i[o];break;case 13:const q=i[o-1];q.description=y.trimColon(i[o]),this.$=q;break;case 14:this.$={stmt:"relation",state1:i[o-2],state2:i[o]};break;case 15:const gt=y.trimColon(i[o]);this.$={stmt:"relation",state1:i[o-3],state2:i[o-1],description:gt};break;case 19:this.$={stmt:"state",id:i[o-3],type:"default",description:"",doc:i[o-1]};break;case 20:var B=i[o],H=i[o-2].trim();if(i[o].match(":")){var ht=i[o].split(":");B=ht[0],H=[H,ht[1]]}this.$={stmt:"state",id:B,type:"default",description:H};break;case 21:this.$={stmt:"state",id:i[o-3],type:"default",description:i[o-5],doc:i[o-1]};break;case 22:this.$={stmt:"state",id:i[o],type:"fork"};break;case 23:this.$={stmt:"state",id:i[o],type:"join"};break;case 24:this.$={stmt:"state",id:i[o],type:"choice"};break;case 25:this.$={stmt:"state",id:y.getDividerId(),type:"divider"};break;case 26:this.$={stmt:"state",id:i[o-1].trim(),note:{position:i[o-2].trim(),text:i[o].trim()}};break;case 29:this.$=i[o].trim(),y.setAccTitle(this.$);break;case 30:case 31:this.$=i[o].trim(),y.setAccDescription(this.$);break;case 32:this.$={stmt:"click",id:i[o-3],url:i[o-2],tooltip:i[o-1]};break;case 33:this.$={stmt:"click",id:i[o-3],url:i[o-1],tooltip:""};break;case 34:case 35:this.$={stmt:"classDef",id:i[o-1].trim(),classes:i[o].trim()};break;case 36:this.$={stmt:"style",id:i[o-1].trim(),styleClass:i[o].trim()};break;case 37:this.$={stmt:"applyClass",id:i[o-1].trim(),styleClass:i[o].trim()};break;case 38:y.setDirection("TB"),this.$={stmt:"dir",value:"TB"};break;case 39:y.setDirection("BT"),this.$={stmt:"dir",value:"BT"};break;case 40:y.setDirection("RL"),this.$={stmt:"dir",value:"RL"};break;case 41:y.setDirection("LR"),this.$={stmt:"dir",value:"LR"};break;case 44:case 45:this.$={stmt:"state",id:i[o].trim(),type:"default",description:""};break;case 46:this.$={stmt:"state",id:i[o-2].trim(),classes:[i[o].trim()],type:"default",description:""};break;case 47:this.$={stmt:"state",id:i[o-2].trim(),classes:[i[o].trim()],type:"default",description:""};break}},"anonymous"),table:[{3:1,4:e,5:l,6:s},{1:[3]},{3:5,4:e,5:l,6:s},{3:6,4:e,5:l,6:s},t([1,4,5,16,17,19,22,24,25,26,27,28,29,33,35,37,38,41,45,48,51,52,53,54,57],u,{7:7}),{1:[2,1]},{1:[2,2]},{1:[2,3],4:d,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:n,19:T,22:m,24:N,25:A,26:k,27:h,28:x,29:D,32:25,33:$,35:L,37:P,38:I,41:J,45:st,48:it,51:rt,52:at,53:nt,54:ot,57:j},t(p,[2,5]),{9:39,10:12,11:13,12:14,13:15,16:g,17:n,19:T,22:m,24:N,25:A,26:k,27:h,28:x,29:D,32:25,33:$,35:L,37:P,38:I,41:J,45:st,48:it,51:rt,52:at,53:nt,54:ot,57:j},t(p,[2,7]),t(p,[2,8]),t(p,[2,9]),t(p,[2,10]),t(p,[2,11]),t(p,[2,12],{14:[1,40],15:[1,41]}),t(p,[2,16]),{18:[1,42]},t(p,[2,18],{20:[1,43]}),{23:[1,44]},t(p,[2,22]),t(p,[2,23]),t(p,[2,24]),t(p,[2,25]),{30:45,31:[1,46],59:[1,47],60:[1,48]},t(p,[2,28]),{34:[1,49]},{36:[1,50]},t(p,[2,31]),{13:51,24:N,57:j},{42:[1,52],44:[1,53]},{46:[1,54]},{49:[1,55]},t(lt,[2,44],{58:[1,56]}),t(lt,[2,45],{58:[1,57]}),t(p,[2,38]),t(p,[2,39]),t(p,[2,40]),t(p,[2,41]),t(p,[2,6]),t(p,[2,13]),{13:58,24:N,57:j},t(p,[2,17]),t(At,u,{7:59}),{24:[1,60]},{24:[1,61]},{23:[1,62]},{24:[2,48]},{24:[2,49]},t(p,[2,29]),t(p,[2,30]),{39:[1,63],40:[1,64]},{43:[1,65]},{43:[1,66]},{47:[1,67]},{50:[1,68]},{24:[1,69]},{24:[1,70]},t(p,[2,14],{14:[1,71]}),{4:d,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:n,19:T,21:[1,72],22:m,24:N,25:A,26:k,27:h,28:x,29:D,32:25,33:$,35:L,37:P,38:I,41:J,45:st,48:it,51:rt,52:at,53:nt,54:ot,57:j},t(p,[2,20],{20:[1,73]}),{31:[1,74]},{24:[1,75]},{39:[1,76]},{39:[1,77]},t(p,[2,34]),t(p,[2,35]),t(p,[2,36]),t(p,[2,37]),t(lt,[2,46]),t(lt,[2,47]),t(p,[2,15]),t(p,[2,19]),t(At,u,{7:78}),t(p,[2,26]),t(p,[2,27]),{5:[1,79]},{5:[1,80]},{4:d,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:n,19:T,21:[1,81],22:m,24:N,25:A,26:k,27:h,28:x,29:D,32:25,33:$,35:L,37:P,38:I,41:J,45:st,48:it,51:rt,52:at,53:nt,54:ot,57:j},t(p,[2,32]),t(p,[2,33]),t(p,[2,21])],defaultActions:{5:[2,1],6:[2,2],47:[2,48],48:[2,49]},parseError:f(function(a,c){if(c.recoverable)this.trace(a);else{var r=new Error(a);throw r.hash=c,r}},"parseError"),parse:f(function(a){var c=this,r=[0],y=[],E=[null],i=[],F=this.table,o="",B=0,H=0,ht=2,q=1,gt=i.slice.call(arguments,1),b=Object.create(this.lexer),M={yy:{}};for(var Tt in this.yy)Object.prototype.hasOwnProperty.call(this.yy,Tt)&&(M.yy[Tt]=this.yy[Tt]);b.setInput(a,M.yy),M.yy.lexer=b,M.yy.parser=this,typeof b.yylloc>"u"&&(b.yylloc={});var Et=b.yylloc;i.push(Et);var qt=b.options&&b.options.ranges;typeof M.yy.parseError=="function"?this.parseError=M.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function Qt(O){r.length=r.length-2*O,E.length=E.length-O,i.length=i.length-O}f(Qt,"popStack");function xt(){var O;return O=y.pop()||b.lex()||q,typeof O!="number"&&(O instanceof Array&&(y=O,O=y.pop()),O=c.symbols_[O]||O),O}f(xt,"lex");for(var C,U,R,_t,z={},ut,G,Lt,dt;;){if(U=r[r.length-1],this.defaultActions[U]?R=this.defaultActions[U]:((C===null||typeof C>"u")&&(C=xt()),R=F[U]&&F[U][C]),typeof R>"u"||!R.length||!R[0]){var mt="";dt=[];for(ut in F[U])this.terminals_[ut]&&ut>ht&&dt.push("'"+this.terminals_[ut]+"'");b.showPosition?mt="Parse error on line "+(B+1)+`:
`+b.showPosition()+`
Expecting `+dt.join(", ")+", got '"+(this.terminals_[C]||C)+"'":mt="Parse error on line "+(B+1)+": Unexpected "+(C==q?"end of input":"'"+(this.terminals_[C]||C)+"'"),this.parseError(mt,{text:b.match,token:this.terminals_[C]||C,line:b.yylineno,loc:Et,expected:dt})}if(R[0]instanceof Array&&R.length>1)throw new Error("Parse Error: multiple actions possible at state: "+U+", token: "+C);switch(R[0]){case 1:r.push(C),E.push(b.yytext),i.push(b.yylloc),r.push(R[1]),C=null,H=b.yyleng,o=b.yytext,B=b.yylineno,Et=b.yylloc;break;case 2:if(G=this.productions_[R[1]][1],z.$=E[E.length-G],z._$={first_line:i[i.length-(G||1)].first_line,last_line:i[i.length-1].last_line,first_column:i[i.length-(G||1)].first_column,last_column:i[i.length-1].last_column},qt&&(z._$.range=[i[i.length-(G||1)].range[0],i[i.length-1].range[1]]),_t=this.performAction.apply(z,[o,H,B,M.yy,R[1],E,i].concat(gt)),typeof _t<"u")return _t;G&&(r=r.slice(0,-1*G*2),E=E.slice(0,-1*G),i=i.slice(0,-1*G)),r.push(this.productions_[R[1]][0]),E.push(z.$),i.push(z._$),Lt=F[r[r.length-2]][r[r.length-1]],r.push(Lt);break;case 3:return!0}}return!0},"parse")},Jt=(function(){var Y={EOF:1,parseError:f(function(c,r){if(this.yy.parser)this.yy.parser.parseError(c,r);else throw new Error(c)},"parseError"),setInput:f(function(a,c){return this.yy=c||this.yy||{},this._input=a,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:f(function(){var a=this._input[0];this.yytext+=a,this.yyleng++,this.offset++,this.match+=a,this.matched+=a;var c=a.match(/(?:\r\n?|\n).*/g);return c?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),a},"input"),unput:f(function(a){var c=a.length,r=a.split(/(?:\r\n?|\n)/g);this._input=a+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-c),this.offset-=c;var y=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),r.length-1&&(this.yylineno-=r.length-1);var E=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:r?(r.length===y.length?this.yylloc.first_column:0)+y[y.length-r.length].length-r[0].length:this.yylloc.first_column-c},this.options.ranges&&(this.yylloc.range=[E[0],E[0]+this.yyleng-c]),this.yyleng=this.yytext.length,this},"unput"),more:f(function(){return this._more=!0,this},"more"),reject:f(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:f(function(a){this.unput(this.match.slice(a))},"less"),pastInput:f(function(){var a=this.matched.substr(0,this.matched.length-this.match.length);return(a.length>20?"...":"")+a.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:f(function(){var a=this.match;return a.length<20&&(a+=this._input.substr(0,20-a.length)),(a.substr(0,20)+(a.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:f(function(){var a=this.pastInput(),c=new Array(a.length+1).join("-");return a+this.upcomingInput()+`
`+c+"^"},"showPosition"),test_match:f(function(a,c){var r,y,E;if(this.options.backtrack_lexer&&(E={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(E.yylloc.range=this.yylloc.range.slice(0))),y=a[0].match(/(?:\r\n?|\n).*/g),y&&(this.yylineno+=y.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:y?y[y.length-1].length-y[y.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+a[0].length},this.yytext+=a[0],this.match+=a[0],this.matches=a,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(a[0].length),this.matched+=a[0],r=this.performAction.call(this,this.yy,this,c,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),r)return r;if(this._backtrack){for(var i in E)this[i]=E[i];return!1}return!1},"test_match"),next:f(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var a,c,r,y;this._more||(this.yytext="",this.match="");for(var E=this._currentRules(),i=0;i<E.length;i++)if(r=this._input.match(this.rules[E[i]]),r&&(!c||r[0].length>c[0].length)){if(c=r,y=i,this.options.backtrack_lexer){if(a=this.test_match(r,E[i]),a!==!1)return a;if(this._backtrack){c=!1;continue}else return!1}else if(!this.options.flex)break}return c?(a=this.test_match(c,E[y]),a!==!1?a:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:f(function(){var c=this.next();return c||this.lex()},"lex"),begin:f(function(c){this.conditionStack.push(c)},"begin"),popState:f(function(){var c=this.conditionStack.length-1;return c>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:f(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:f(function(c){return c=this.conditionStack.length-1-Math.abs(c||0),c>=0?this.conditionStack[c]:"INITIAL"},"topState"),pushState:f(function(c){this.begin(c)},"pushState"),stateStackSize:f(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:f(function(c,r,y,E){function i(){const F=r.yytext.indexOf("%%");if(F===0)return!1;if(F>0){const o=r.yytext.slice(0,F),B=r.yytext.slice(F);B&&c.lexer.unput(B),r.yytext=o}return!0}switch(f(i,"processId"),y){case 0:return 38;case 1:return 40;case 2:return 39;case 3:return 44;case 4:return 51;case 5:return 52;case 6:return 53;case 7:return 54;case 8:return 5;case 9:break;case 10:break;case 11:break;case 12:break;case 13:return this.pushState("SCALE"),17;case 14:return 18;case 15:this.popState();break;case 16:return this.begin("acc_title"),33;case 17:return this.popState(),"acc_title_value";case 18:return this.begin("acc_descr"),35;case 19:return this.popState(),"acc_descr_value";case 20:this.begin("acc_descr_multiline");break;case 21:this.popState();break;case 22:return"acc_descr_multiline_value";case 23:return this.pushState("CLASSDEF"),41;case 24:return this.popState(),this.pushState("CLASSDEFID"),"DEFAULT_CLASSDEF_ID";case 25:return this.popState(),this.pushState("CLASSDEFID"),42;case 26:return this.popState(),43;case 27:return this.pushState("CLASS"),48;case 28:return this.popState(),this.pushState("CLASS_STYLE"),49;case 29:return this.popState(),50;case 30:return this.pushState("STYLE"),45;case 31:return this.popState(),this.pushState("STYLEDEF_STYLES"),46;case 32:return this.popState(),47;case 33:return this.pushState("SCALE"),17;case 34:return 18;case 35:this.popState();break;case 36:this.pushState("STATE");break;case 37:return this.popState(),r.yytext=r.yytext.slice(0,-8).trim(),25;case 38:return this.popState(),r.yytext=r.yytext.slice(0,-8).trim(),26;case 39:return this.popState(),r.yytext=r.yytext.slice(0,-10).trim(),27;case 40:return this.popState(),r.yytext=r.yytext.slice(0,-8).trim(),25;case 41:return this.popState(),r.yytext=r.yytext.slice(0,-8).trim(),26;case 42:return this.popState(),r.yytext=r.yytext.slice(0,-10).trim(),27;case 43:return 51;case 44:return 52;case 45:return 53;case 46:return 54;case 47:this.pushState("STATE_STRING");break;case 48:return this.pushState("STATE_ID"),"AS";case 49:return i()?(this.popState(),"ID"):void 0;case 50:this.popState();break;case 51:return"STATE_DESCR";case 52:return 19;case 53:this.popState();break;case 54:return this.popState(),this.pushState("struct"),20;case 55:return this.popState(),21;case 56:break;case 57:return this.begin("NOTE"),29;case 58:return this.popState(),this.pushState("NOTE_ID"),59;case 59:return this.popState(),this.pushState("NOTE_ID"),60;case 60:this.popState(),this.pushState("FLOATING_NOTE");break;case 61:return this.popState(),this.pushState("FLOATING_NOTE_ID"),"AS";case 62:break;case 63:return"NOTE_TEXT";case 64:return i()?(this.popState(),"ID"):void 0;case 65:return i()?(this.popState(),this.pushState("NOTE_TEXT"),24):void 0;case 66:return this.popState(),r.yytext=r.yytext.substr(2).trim(),31;case 67:return this.popState(),r.yytext=r.yytext.slice(0,-8).trim(),31;case 68:return 6;case 69:return 6;case 70:return 16;case 71:return 57;case 72:return i()?24:void 0;case 73:return r.yytext=r.yytext.trim(),14;case 74:return 15;case 75:return 28;case 76:return 58;case 77:return 5;case 78:return"INVALID"}},"anonymous"),rules:[/^(?:click\b)/i,/^(?:href\b)/i,/^(?:"[^"]*")/i,/^(?:default\b)/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:[\n]+)/i,/^(?:[\s]+)/i,/^(?:((?!\n)\s)+)/i,/^(?:#[^\n]*)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:classDef\s+)/i,/^(?:DEFAULT\s+)/i,/^(?:\w+\s+)/i,/^(?:[^\n]*)/i,/^(?:class\s+)/i,/^(?:(\w+)+((,\s*\w+)*))/i,/^(?:[^\n]*)/i,/^(?:style\s+)/i,/^(?:[\w,]+\s+)/i,/^(?:[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:state\s+)/i,/^(?:.*<<fork>>)/i,/^(?:.*<<join>>)/i,/^(?:.*<<choice>>)/i,/^(?:.*\[\[fork\]\])/i,/^(?:.*\[\[join\]\])/i,/^(?:.*\[\[choice\]\])/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:["])/i,/^(?:\s*as\s+)/i,/^(?:[^\n\{]*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n\s\{]+)/i,/^(?:\n)/i,/^(?:\{)/i,/^(?:\})/i,/^(?:[\n])/i,/^(?:note\s+)/i,/^(?:left of\b)/i,/^(?:right of\b)/i,/^(?:")/i,/^(?:\s*as\s*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n]*)/i,/^(?:\s*[^:\n\s\-]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:[\s\S]*?\n\s*end note\b)/i,/^(?:stateDiagram\s+)/i,/^(?:stateDiagram-v2\s+)/i,/^(?:hide empty description\b)/i,/^(?:\[\*\])/i,/^(?:[^:\n\s\-\{]+)/i,/^(?:\s*:(?:[^:\n;]|:[^:\n;])+)/i,/^(?:-->)/i,/^(?:--)/i,/^(?::::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{LINE:{rules:[10,11,12],inclusive:!1},struct:{rules:[10,11,12,23,27,30,36,43,44,45,46,55,56,57,71,72,73,74,75,76],inclusive:!1},FLOATING_NOTE_ID:{rules:[64],inclusive:!1},FLOATING_NOTE:{rules:[61,62,63],inclusive:!1},NOTE_TEXT:{rules:[66,67],inclusive:!1},NOTE_ID:{rules:[65],inclusive:!1},NOTE:{rules:[58,59,60],inclusive:!1},STYLEDEF_STYLEOPTS:{rules:[],inclusive:!1},STYLEDEF_STYLES:{rules:[32],inclusive:!1},STYLE_IDS:{rules:[],inclusive:!1},STYLE:{rules:[31],inclusive:!1},CLASS_STYLE:{rules:[29],inclusive:!1},CLASS:{rules:[28],inclusive:!1},CLASSDEFID:{rules:[26],inclusive:!1},CLASSDEF:{rules:[24,25],inclusive:!1},acc_descr_multiline:{rules:[21,22],inclusive:!1},acc_descr:{rules:[19],inclusive:!1},acc_title:{rules:[17],inclusive:!1},SCALE:{rules:[14,15,34,35],inclusive:!1},ALIAS:{rules:[],inclusive:!1},STATE_ID:{rules:[49],inclusive:!1},STATE_STRING:{rules:[50,51],inclusive:!1},FORK_STATE:{rules:[],inclusive:!1},STATE:{rules:[10,11,12,37,38,39,40,41,42,47,48,52,53,54],inclusive:!1},ID:{rules:[10,11,12],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,8,9,11,12,13,16,18,20,23,27,30,33,36,54,57,68,69,70,71,72,73,74,76,77,78],inclusive:!0}}};return Y})();yt.lexer=Jt;function ct(){this.yy={}}return f(ct,"Parser"),ct.prototype=yt,yt.Parser=ct,new ct})();Dt.parser=Dt;var Ge=Dt,ue="TB",Ft="TB",It="dir",X="state",K="root",vt="relation",de="classDef",fe="style",pe="applyClass",tt="default",Bt="divider",Gt="fill:none",Yt="fill: #333",Vt="c",Mt="markdown",Ut="normal",bt="rect",kt="rectWithTitle",Se="stateStart",ye="stateEnd",Ot="divider",Nt="roundedWithTitle",ge="note",Te="noteGroup",et="statediagram",Ee="state",_e=`${et}-${Ee}`,Wt="transition",me="note",be="note-edge",ke=`${Wt} ${be}`,De=`${et}-${me}`,ve="cluster",Ce=`${et}-${ve}`,Ae="cluster-alt",xe=`${et}-${Ae}`,jt="parent",Ht="note",Le="state",Ct="----",Ie=`${Ct}${Ht}`,Rt=`${Ct}${jt}`,zt=f((t,e=Ft)=>{if(!t.doc)return e;let l=e;for(const s of t.doc)s.stmt==="dir"&&(l=s.value);return l},"getDir"),Oe=f(function(t,e){return e.db.getClasses()},"getClasses"),Ne=f(async function(t,e,l,s){_.info("REF0:"),_.info("Drawing state diagram (v2)",e);const{securityLevel:u,state:d,layout:S}=w();s.db.extract(s.db.getRootDocV2());const g=s.db.getData(),n=Zt(e,u);g.type=s.type,g.layoutAlgorithm=S,g.nodeSpacing=d?.nodeSpacing||50,g.rankSpacing=d?.rankSpacing||50,w().look==="neo"?g.markers=["barbNeo"]:g.markers=["barb"],g.diagramId=e,await ee(g,n);const m=8;try{(typeof s.db.getLinks=="function"?s.db.getLinks():new Map).forEach((A,k)=>{const h=typeof k=="string"?k:typeof k?.id=="string"?k.id:"";if(!h){_.warn("⚠️ Invalid or missing stateId from key:",JSON.stringify(k));return}const x=n.node()?.querySelectorAll("g");let D;if(x?.forEach(I=>{I.textContent?.trim()===h&&(D=I)}),!D){_.warn("⚠️ Could not find node matching text:",h);return}const $=D.parentNode;if(!$){_.warn("⚠️ Node has no parent, cannot wrap:",h);return}const L=document.createElementNS("http://www.w3.org/2000/svg","a"),P=A.url.replace(/^"+|"+$/g,"");if(L.setAttributeNS("http://www.w3.org/1999/xlink","xlink:href",P),L.setAttribute("target","_blank"),A.tooltip){const I=A.tooltip.replace(/^"+|"+$/g,"");L.setAttribute("title",I)}$.replaceChild(L,D),L.appendChild(D),_.info("🔗 Wrapped node in <a> tag for:",h,A.url)})}catch(N){_.error("❌ Error injecting clickable links:",N)}se.insertTitle(n,"statediagramTitleText",d?.titleTopMargin??25,s.db.getDiagramTitle()),te(n,m,et,d?.useMaxWidth??!0)},"draw"),Ye={getClasses:Oe,draw:Ne,getDir:zt},pt=new Map,V=0;function St(t="",e=0,l="",s=Ct){const u=l!==null&&l.length>0?`${s}${l}`:"";return`${Le}-${t}${u}-${e}`}f(St,"stateDomId");var Re=f((t,e,l,s,u,d,S,g)=>{_.trace("items",e),e.forEach(n=>{switch(n.stmt){case X:Z(t,n,l,s,u,d,S,g);break;case tt:Z(t,n,l,s,u,d,S,g);break;case vt:{Z(t,n.state1,l,s,u,d,S,g),Z(t,n.state2,l,s,u,d,S,g);const T=S==="neo",m={id:"edge"+V,start:n.state1.id,end:n.state2.id,arrowhead:"normal",arrowTypeEnd:T?"arrow_barb_neo":"arrow_barb",style:Gt,labelStyle:"",label:W.sanitizeText(n.description??"",w()),arrowheadStyle:Yt,labelpos:Vt,labelType:Mt,thickness:Ut,classes:Wt,look:S};u.push(m),V++}break}})},"setupDoc"),wt=f((t,e=Ft)=>{let l=e;if(t.doc)for(const s of t.doc)s.stmt==="dir"&&(l=s.value);return l},"getDir");function Q(t,e,l){if(!e.id||e.id==="</join></fork>"||e.id==="</choice>")return;e.cssClasses&&(Array.isArray(e.cssCompiledStyles)||(e.cssCompiledStyles=[]),e.cssClasses.split(" ").forEach(u=>{const d=l.get(u);d&&(e.cssCompiledStyles=[...e.cssCompiledStyles??[],...d.styles])}));const s=t.find(u=>u.id===e.id);s?Object.assign(s,e):t.push(e)}f(Q,"insertOrUpdateNode");function Kt(t){return t?.classes?.join(" ")??""}f(Kt,"getClassesFromDbInfo");function Xt(t){return t?.styles??[]}f(Xt,"getStylesFromDbInfo");var Z=f((t,e,l,s,u,d,S,g)=>{const n=e.id,T=l.get(n),m=Kt(T),N=Xt(T),A=w();if(_.info("dataFetcher parsedItem",e,T,N),n!=="root"){let k=bt;e.start===!0?k=Se:e.start===!1&&(k=ye),e.type!==tt&&(k=e.type),pt.get(n)||pt.set(n,{id:n,shape:k,description:W.sanitizeText(n,A),cssClasses:`${m} ${_e}`,cssStyles:N});const h=pt.get(n);e.description&&(Array.isArray(h.description)?(h.shape=kt,h.description.push(e.description)):h.description?.length&&h.description.length>0?(h.shape=kt,h.description===n?h.description=[e.description]:h.description=[h.description,e.description]):(h.shape=bt,h.description=e.description),h.description=W.sanitizeTextOrArray(h.description,A)),h.description?.length===1&&h.shape===kt&&(h.type==="group"?h.shape=Nt:h.shape=bt),!h.type&&e.doc&&(_.info("Setting cluster for XCX",n,wt(e)),h.type="group",h.isGroup=!0,h.dir=wt(e),h.shape=e.type===Bt?Ot:Nt,h.cssClasses=`${h.cssClasses} ${Ce} ${d?xe:""}`);const x={labelStyle:"",shape:h.shape,label:h.description,cssClasses:h.cssClasses,cssCompiledStyles:[],cssStyles:h.cssStyles,id:n,dir:h.dir,domId:St(n,V),type:h.type,isGroup:h.type==="group",padding:8,rx:10,ry:10,look:S,labelType:"markdown"};if(x.shape===Ot&&(x.label=""),t&&t.id!=="root"&&(_.trace("Setting node ",n," to be child of its parent ",t.id),x.parentId=t.id),x.centerLabel=!0,e.note){const D={labelStyle:"",shape:ge,label:e.note.text,labelType:"markdown",cssClasses:De,cssStyles:[],cssCompiledStyles:[],id:n+Ie+"-"+V,domId:St(n,V,Ht),type:h.type,isGroup:h.type==="group",padding:A.flowchart?.padding,look:S,position:e.note.position},$=n+Rt,L={labelStyle:"",shape:Te,label:e.note.text,cssClasses:h.cssClasses,cssStyles:[],id:n+Rt,domId:St(n,V,jt),type:"group",isGroup:!0,padding:16,look:S,position:e.note.position};V++,L.id=$,D.parentId=$,Q(s,L,g),Q(s,D,g),Q(s,x,g);let P=n,I=D.id;e.note.position==="left of"&&(P=D.id,I=n),u.push({id:P+"-"+I,start:P,end:I,arrowhead:"none",arrowTypeEnd:"",style:Gt,labelStyle:"",classes:ke,arrowheadStyle:Yt,labelpos:Vt,labelType:Mt,thickness:Ut,look:S})}else Q(s,x,g)}e.doc&&(_.trace("Adding nodes children "),Re(e,e.doc,l,s,u,!d,S,g))},"dataFetcher"),we=f(()=>{pt.clear(),V=0},"reset"),v={START_NODE:"[*]",START_TYPE:"start",END_NODE:"[*]",END_TYPE:"end",COLOR_KEYWORD:"color",FILL_KEYWORD:"fill",BG_FILL:"bgFill",STYLECLASS_SEP:","},$t=f(()=>new Map,"newClassesList"),Pt=f(()=>({relations:[],states:new Map,documents:{}}),"newDoc"),ft=f(t=>JSON.parse(JSON.stringify(t)),"clone"),Ve=class{constructor(t){this.version=t,this.nodes=[],this.edges=[],this.rootDoc=[],this.classes=$t(),this.documents={root:Pt()},this.currentDocument=this.documents.root,this.startEndCount=0,this.dividerCnt=0,this.links=new Map,this.getAccTitle=ie,this.setAccTitle=re,this.getAccDescription=ae,this.setAccDescription=ne,this.setDiagramTitle=oe,this.getDiagramTitle=le,this.clear(),this.setRootDoc=this.setRootDoc.bind(this),this.getDividerId=this.getDividerId.bind(this),this.setDirection=this.setDirection.bind(this),this.trimColon=this.trimColon.bind(this)}static{f(this,"StateDB")}static{this.relationType={AGGREGATION:0,EXTENSION:1,COMPOSITION:2,DEPENDENCY:3}}extract(t){this.clear(!0);for(const s of Array.isArray(t)?t:t.doc)switch(s.stmt){case X:this.addState(s.id.trim(),s.type,s.doc,s.description,s.note);break;case vt:this.addRelation(s.state1,s.state2,s.description);break;case de:this.addStyleClass(s.id.trim(),s.classes);break;case fe:this.handleStyleDef(s);break;case pe:this.setCssClass(s.id.trim(),s.styleClass);break;case"click":this.addLink(s.id,s.url,s.tooltip);break}const e=this.getStates(),l=w();we(),Z(void 0,this.getRootDocV2(),e,this.nodes,this.edges,!0,l.look,this.classes);for(const s of this.nodes)if(Array.isArray(s.label)){if(s.description=s.label.slice(1),s.isGroup&&s.description.length>0)throw new Error(`Group nodes can only have label. Remove the additional description for node [${s.id}]`);s.label=s.label[0]}}handleStyleDef(t){const e=t.id.trim().split(","),l=t.styleClass.split(",");for(const s of e){let u=this.getState(s);if(!u){const d=s.trim();this.addState(d),u=this.getState(d)}u&&(u.styles=l.map(d=>d.replace(/;/g,"")?.trim()))}}setRootDoc(t){_.info("Setting root doc",t),this.rootDoc=t,this.version===1?this.extract(t):this.extract(this.getRootDocV2())}docTranslator(t,e,l){if(e.stmt===vt){this.docTranslator(t,e.state1,!0),this.docTranslator(t,e.state2,!1);return}if(e.stmt===X&&(e.id===v.START_NODE?(e.id=t.id+(l?"_start":"_end"),e.start=l):e.id=e.id.trim()),e.stmt!==K&&e.stmt!==X||!e.doc)return;const s=[];let u=[];for(const d of e.doc)if(d.type===Bt){const S=ft(d);S.doc=ft(u),s.push(S),u=[]}else u.push(d);if(s.length>0&&u.length>0){const d={stmt:X,id:ce(),type:"divider",doc:ft(u)};s.push(ft(d)),e.doc=s}e.doc.forEach(d=>this.docTranslator(e,d,!0))}getRootDocV2(){return this.docTranslator({id:K,stmt:K},{id:K,stmt:K,doc:this.rootDoc},!0),{id:K,doc:this.rootDoc}}addState(t,e=tt,l=void 0,s=void 0,u=void 0,d=void 0,S=void 0,g=void 0){const n=t?.trim();if(!this.currentDocument.states.has(n))_.info("Adding state ",n,s),this.currentDocument.states.set(n,{stmt:X,id:n,descriptions:[],type:e,doc:l,note:u,classes:[],styles:[],textStyles:[]});else{const T=this.currentDocument.states.get(n);if(!T)throw new Error(`State not found: ${n}`);T.doc||(T.doc=l),T.type||(T.type=e)}if(s&&(_.info("Setting state description",n,s),(Array.isArray(s)?s:[s]).forEach(m=>this.addDescription(n,m.trim()))),u){const T=this.currentDocument.states.get(n);if(!T)throw new Error(`State not found: ${n}`);T.note=u,T.note.text=W.sanitizeText(T.note.text,w())}d&&(_.info("Setting state classes",n,d),(Array.isArray(d)?d:[d]).forEach(m=>this.setCssClass(n,m.trim()))),S&&(_.info("Setting state styles",n,S),(Array.isArray(S)?S:[S]).forEach(m=>this.setStyle(n,m.trim()))),g&&(_.info("Setting state styles",n,S),(Array.isArray(g)?g:[g]).forEach(m=>this.setTextStyle(n,m.trim())))}clear(t){this.nodes=[],this.edges=[],this.documents={root:Pt()},this.currentDocument=this.documents.root,this.startEndCount=0,this.classes=$t(),t||(this.links=new Map,he())}getState(t){return this.currentDocument.states.get(t)}getStates(){return this.currentDocument.states}logDocuments(){_.info("Documents = ",this.documents)}getRelations(){return this.currentDocument.relations}addLink(t,e,l){this.links.set(t,{url:e,tooltip:l}),_.warn("Adding link",t,e,l)}getLinks(){return this.links}startIdIfNeeded(t=""){return t===v.START_NODE?(this.startEndCount++,`${v.START_TYPE}${this.startEndCount}`):t}startTypeIfNeeded(t="",e=tt){return t===v.START_NODE?v.START_TYPE:e}endIdIfNeeded(t=""){return t===v.END_NODE?(this.startEndCount++,`${v.END_TYPE}${this.startEndCount}`):t}endTypeIfNeeded(t="",e=tt){return t===v.END_NODE?v.END_TYPE:e}addRelationObjs(t,e,l=""){const s=this.startIdIfNeeded(t.id.trim()),u=this.startTypeIfNeeded(t.id.trim(),t.type),d=this.startIdIfNeeded(e.id.trim()),S=this.startTypeIfNeeded(e.id.trim(),e.type);this.addState(s,u,t.doc,t.description,t.note,t.classes,t.styles,t.textStyles),this.addState(d,S,e.doc,e.description,e.note,e.classes,e.styles,e.textStyles),this.currentDocument.relations.push({id1:s,id2:d,relationTitle:W.sanitizeText(l,w())})}addRelation(t,e,l){if(typeof t=="object"&&typeof e=="object")this.addRelationObjs(t,e,l);else if(typeof t=="string"&&typeof e=="string"){const s=this.startIdIfNeeded(t.trim()),u=this.startTypeIfNeeded(t),d=this.endIdIfNeeded(e.trim()),S=this.endTypeIfNeeded(e);this.addState(s,u),this.addState(d,S),this.currentDocument.relations.push({id1:s,id2:d,relationTitle:l?W.sanitizeText(l,w()):void 0})}}addDescription(t,e){const l=this.currentDocument.states.get(t),s=e.startsWith(":")?e.replace(":","").trim():e;l?.descriptions?.push(W.sanitizeText(s,w()))}cleanupLabel(t){return t.startsWith(":")?t.slice(2).trim():t.trim()}getDividerId(){return this.dividerCnt++,`divider-id-${this.dividerCnt}`}addStyleClass(t,e=""){this.classes.has(t)||this.classes.set(t,{id:t,styles:[],textStyles:[]});const l=this.classes.get(t);e&&l&&e.split(v.STYLECLASS_SEP).forEach(s=>{const u=s.replace(/([^;]*);/,"$1").trim();if(RegExp(v.COLOR_KEYWORD).exec(s)){const S=u.replace(v.FILL_KEYWORD,v.BG_FILL).replace(v.COLOR_KEYWORD,v.FILL_KEYWORD);l.textStyles.push(S)}l.styles.push(u)})}getClasses(){return this.classes}setCssClass(t,e){t.split(",").forEach(l=>{let s=this.getState(l);if(!s){const u=l.trim();this.addState(u),s=this.getState(u)}s?.classes?.push(e)})}setStyle(t,e){this.getState(t)?.styles?.push(e)}setTextStyle(t,e){this.getState(t)?.textStyles?.push(e)}getDirectionStatement(){return this.rootDoc.find(t=>t.stmt===It)}getDirection(){return this.getDirectionStatement()?.value??ue}setDirection(t){const e=this.getDirectionStatement();e?e.value=t:this.rootDoc.unshift({stmt:It,value:t})}trimColon(t){return t.startsWith(":")?t.slice(1).trim():t.trim()}getData(){const t=w();return{nodes:this.nodes,edges:this.edges,other:{},config:t,direction:zt(this.getRootDocV2())}}getConfig(){return w().state}},$e=f(t=>`
defs [id$="-barbEnd"] {
    fill: ${t.transitionColor};
    stroke: ${t.transitionColor};
  }
g.stateGroup text {
  fill: ${t.nodeBorder};
  stroke: none;
  font-size: 10px;
}
g.stateGroup text {
  fill: ${t.textColor};
  stroke: none;
  font-size: 10px;

}
g.stateGroup .state-title {
  font-weight: bolder;
  fill: ${t.stateLabelColor};
}

g.stateGroup rect {
  fill: ${t.mainBkg};
  stroke: ${t.nodeBorder};
}

g.stateGroup line {
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.transition {
  stroke: ${t.transitionColor};
  stroke-width: ${t.strokeWidth||1};
  fill: none;
}

.stateGroup .composit {
  fill: ${t.background};
  border-bottom: 1px
}

.stateGroup .alt-composit {
  fill: #e0e0e0;
  border-bottom: 1px
}

.state-note {
  stroke: ${t.noteBorderColor};
  fill: ${t.noteBkgColor};

  text {
    fill: ${t.noteTextColor};
    stroke: none;
    font-size: 10px;
  }
}

.stateLabel .box {
  stroke: none;
  stroke-width: 0;
  fill: ${t.mainBkg};
  opacity: 0.5;
}

.edgeLabel .label rect {
  fill: ${t.labelBackgroundColor};
  opacity: 0.5;
}
.edgeLabel {
  background-color: ${t.edgeLabelBackground};
  p {
    background-color: ${t.edgeLabelBackground};
  }
  rect {
    opacity: 0.5;
    background-color: ${t.edgeLabelBackground};
    fill: ${t.edgeLabelBackground};
  }
  text-align: center;
}
.edgeLabel .label text {
  fill: ${t.transitionLabelColor||t.tertiaryTextColor};
}
.label div .edgeLabel {
  color: ${t.transitionLabelColor||t.tertiaryTextColor};
}

.stateLabel text {
  fill: ${t.stateLabelColor};
  font-size: 10px;
  font-weight: bold;
}

.node circle.state-start {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node .fork-join {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node circle.state-end {
  fill: ${t.innerEndBackground};
  stroke: ${t.background};
  stroke-width: 1.5
}
.end-state-inner {
  fill: ${t.compositeBackground||t.background};
  // stroke: ${t.background};
  stroke-width: 1.5
}

.node rect {
  fill: ${t.stateBkg||t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}
.node polygon {
  fill: ${t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};;
  stroke-width: ${t.strokeWidth||1}px;
}
[id$="-barbEnd"] {
  fill: ${t.lineColor};
}

.statediagram-cluster rect {
  fill: ${t.compositeTitleBackground};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth||1}px;
}

.cluster-label, .nodeLabel {
  color: ${t.stateLabelColor};
  // line-height: 1;
}

.statediagram-cluster rect.outer {
  rx: 5px;
  ry: 5px;
}
.statediagram-state .divider {
  stroke: ${t.stateBorder||t.nodeBorder};
}

.statediagram-state .title-state {
  rx: 5px;
  ry: 5px;
}
.statediagram-cluster.statediagram-cluster .inner {
  fill: ${t.compositeBackground||t.background};
}
.statediagram-cluster.statediagram-cluster-alt .inner {
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.statediagram-cluster .inner {
  rx:0;
  ry:0;
}

.statediagram-state rect.basic {
  rx: 5px;
  ry: 5px;
}
.statediagram-state rect.divider {
  stroke-dasharray: 10,10;
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.note-edge {
  stroke-dasharray: 5;
}

.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}
.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}

.statediagram-note text {
  fill: ${t.noteTextColor};
}

.statediagram-note .nodeLabel {
  color: ${t.noteTextColor};
}
.statediagram .edgeLabel {
  color: red; // ${t.noteTextColor};
}

[id$="-dependencyStart"], [id$="-dependencyEnd"] {
  fill: ${t.lineColor};
  stroke: ${t.lineColor};
  stroke-width: ${t.strokeWidth||1};
}

.statediagramTitleText {
  text-anchor: middle;
  font-size: 18px;
  fill: ${t.textColor};
}

[data-look="neo"].statediagram-cluster rect {
  fill: ${t.mainBkg};
  stroke: ${t.useGradient?"url("+t.svgId+"-gradient)":t.stateBorder||t.nodeBorder};
  stroke-width: ${t.strokeWidth??1};
}
[data-look="neo"].statediagram-cluster rect.outer {
  rx: ${t.radius}px;
  ry: ${t.radius}px;
  filter: ${t.dropShadow?t.dropShadow.replace("url(#drop-shadow)",`url(${t.svgId}-drop-shadow)`):"none"}
}
`,"getStyles"),Me=$e;export{Ve as S,Ge as a,Ye as b,Me as s};
