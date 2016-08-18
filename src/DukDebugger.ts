'use strict';

import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint, Variable, ErrorDestination
} from 'vscode-debugadapter';

import {
    DebugProtocol
} from 'vscode-debugprotocol';

import * as Net  from 'net';
import * as Path from 'path';
import * as FS   from 'fs';
import * as util from 'util';

import {
    DukDbgProtocol,
    DukEvent,
    DukStatusState,

    /// Notifications
    DukStatusNotification,
    DukPrintNotification,
    DukAlertNotification,
    DukLogNotification,
    DukThrowNotification,

    // Responses
    DukListBreakResponse,
    DukAddBreakResponse,
    DukGetCallStackResponse,
    DukCallStackEntry,
    DukGetLocalsResponse,
    DukEvalResponse,
    DukInspectHeapObjResponse,
    DukGetClosureResponse

} from "./DukDbgProtocol";

import * as Duk from "./DukConsts";


/**
 * This interface should always match the schema found in the duk-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the bundle to debug. */
	bundle: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** VS Code's root directory. */
	localRoot?: string;
	/** Address of host running the script engine. */
	host?: string;
	/** Port on which the script engine is listening. */
	port?: number;
}

// Utitity
class ArrayX
{
    public static firstOrNull<T>( target:Array<T>, comparer:( value:T ) => boolean ) : T
    {
        for( let i=0; i < target.length; i++ )
            if( comparer( target[i] ) )
                return target[i];

        return null;
    }

    public static convert<T,U>( target:Array<T>, converter:( value:T ) => U ) : Array<U>
    {
        let result = new Array<U>( target.length );
        for( let i=0; i < target.length; i++ )
            result[i] = converter( target[i] );

        return result;
    }
}

class DukBreakPoint
{
    public dukIdx:number;   // duktape breakpoint index
    public line  :number;   // Front-end line number

    constructor( index:number, line:number )
    {
        this.dukIdx = index;
        this.line   = line;
    }
}

class SourceFile
{
    public id         :number;
    public name       :string;
    public path       :string;

    public srcMapPath :string;
    //public srcMap     :SourceMap;

    public breakpoints:DukBreakPoint[];

    constructor()
    {
        this.breakpoints = new Array<DukBreakPoint>();
    }
}

class DukVar
{
    public name       :string;
    public value      :string;
    public type       :string;

    constructor( name:string, value:string )
    {
        this.name       = name;
        this.value      = value;
    }
}

type PropertyInfo = { n:string, t:string, v:any };

enum PropertySetType
{
    Scope  = 0,
    Object,
    Internal
}

class PropertySet
{
    public handle    :number;
    public prefix    :string;
    public ctorName  :string;   // TODO: Remove prefix, not using it anymore

    public heapPtr   :Duk.TValPointer;
    public scope     :DukScope;
    public type      :PropertySetType;
    public keys      :string[];
    public variables :Variable[];

    public constructor( prefix:string, type:PropertySetType )
    {
        this.prefix = prefix;
        this.type   = type;
    }
}

class DukScope
{
    public handle     :number;
    public name       :string;
    public stackFrame :DukStackFrame;
    public properties :PropertySet;

    public constructor( name:string, stackFrame:DukStackFrame, properties:PropertySet )
    {
        this.name       = name;
        this.stackFrame = stackFrame;
        this.properties = properties;
    }
}

class DukStackFrame
{
    public handle     :number;
    public source     :SourceFile;
    public fileName   :string;
    public funcName   :string;
    public lineNumber :number;
    public pc         :number;
    public depth      :number;
    public klass      :string;
    public scopes     :DukScope[];

    public constructor( source:SourceFile, fileName:string, funcName:string,
                        lineNumber:number, pc:number, depth:number,
                        scopes:DukScope[] )
    {
        this.source     = source     ;
        this.fileName   = fileName   ;
        this.funcName   = funcName   ;
        this.lineNumber = lineNumber ;
        this.pc         = pc         ;
        this.depth      = depth      ;
        this.scopes     = scopes     ;
    }
}

class PtrPropDict {  [key:string]:PropertySet };

class DbgClientState
{
    public paused        :boolean;
    public expectingBreak:string;

    public ptrHandles   :PtrPropDict;            // Access to property sets via pointers
    public varHandles   :Handles<PropertySet>;   // Handles to property sets
    public stackFrames  :Handles<DukStackFrame>;
    public scopes       :Handles<DukScope>;
    public nextSrcID    :number;


    public reset() : void
    {
        this.paused         = false;
        this.expectingBreak = undefined;
        this.ptrHandles     = new PtrPropDict();
        this.varHandles     = new Handles<PropertySet>();
        this.stackFrames    = new Handles<DukStackFrame>();
        this.scopes         = new Handles<DukScope>();
        this.nextSrcID      = 1;
    }
}

class ErrorCode
{
    public static RequestFailed = 100;
}

class DukDebugSession extends DebugSession
{
	private static THREAD_ID = 1;


    private _args           :LaunchRequestArguments;
    private _sources        :{};
    private _sourceRoot     :string;
    private _stopOnEntry    :boolean;
    private _dukProto       :DukDbgProtocol;

    private _dbgState       :DbgClientState;
    private _initResponse   :DebugProtocol.Response;

    private _awaitingInitialStatus:boolean;
    private _initialStatus  :DukStatusNotification;


	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();
        this.logToClient( "DukDebugSession()" );

		// this debugger uses one-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

        this._dbgState = new DbgClientState();

        this.initDukDbgProtocol();
	}

    //-----------------------------------------------------------
    private initDukDbgProtocol() : void
    {
        this._dukProto = new DukDbgProtocol( ( msg ) => this.logToClient(msg) );

        // Status
        this._dukProto.on( DukEvent[DukEvent.nfy_status], ( status:DukStatusNotification ) => {

            this.logToClient( "Status Notification: " +
                (status.state == DukStatusState.Paused ? "pause" : "running") );

            let stopReason = this._dbgState.expectingBreak || "debugger";

            this._dbgState.expectingBreak = undefined;

            if( !this._initialStatus ) {
                if( this._awaitingInitialStatus ) {
                    this._initialStatus = status;
                    this._awaitingInitialStatus = false;
                }
            }

            // Pause/Unpause
            if( status.state == DukStatusState.Paused ) {
                //this.logToClient( "Pause reported" );
                this._dbgState.reset();
                this._dbgState.paused = true;
                this.sendEvent( new StoppedEvent( stopReason, DukDebugSession.THREAD_ID ) );
            } else {
                // Resume
                //this._dbgState.reset();
                this._dbgState.paused = false;
                // TODO: Resume?
            }
        });

        // Disconnect
        this._dukProto.once( DukEvent[DukEvent.disconnected], ( reason:string) => {
            this.logToClient( `Disconnected: ${reason}` );
            this.sendEvent( new TerminatedEvent() );
        });

        // Output
        this._dukProto.on( DukEvent[DukEvent.nfy_print], ( e:DukPrintNotification ) => {
            this.logToClient( e.message );
        });

        this._dukProto.on( DukEvent[DukEvent.nfy_alert], ( e:DukAlertNotification ) => {
            this.logToClient( e.message );
        });

        this._dukProto.on( DukEvent[DukEvent.nfy_log], ( e:DukLogNotification ) => {
            this.logToClient( e.message );
        });

        // Throw
        this._dukProto.on( DukEvent[DukEvent.nfy_throw], ( e:DukThrowNotification ) => {
            this.logToClient( `Exception thrown @ ${e.fileName}:${e.lineNumber} : ${e.message}` );
        });
    }

    //-----------------------------------------------------------
    // Begin initialization. Attempt to connect to target
    //-----------------------------------------------------------
    private beginInit( response:DebugProtocol.Response, host:string, port:number ) : void
    {
        this._initialStatus         = null;
        this._awaitingInitialStatus = false;

        // Attached to Debug Server
        this._dukProto.once( DukEvent[DukEvent.attached], ( success:boolean ) => {

            if( success )
            {
                this.logToClient( "Attached to duktape debugger." );
                this.finalizeInit( response );
            }
            else
            {
                this.logToClient( "Attach failed." );
                this.sendErrorResponse( response, 0, "Attach failed" );
            }
        });

        this._dukProto.attach( host, port );
    }

    //-----------------------------------------------------------
    // Finalize initialization, sned initialized event
    //-----------------------------------------------------------
    private finalizeInit( response:DebugProtocol.Response ) : void
    {
        this.logToClient( "Finalized Initialization." );

        this._sources = {};
        this._dbgState.reset();
        this._initResponse = null;

        // Make sure that any breakpoints that were left set in
        // case of a broken connection are cleared
        this.removeAllTargetBreakpoints().catch()
        .then( () => {

            this._awaitingInitialStatus = true;

            // Set initial paused state
            if( this._args.stopOnEntry )
                this._dukProto.requestPause();
            else
                this._dukProto.requestResume();
        }).catch();

        // Let the front end know we're done initializing
        this.sendResponse( response );
        this.sendEvent( new InitializedEvent() );
		this.sendEvent(new StoppedEvent("entry", DukDebugSession.THREAD_ID));
   }

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest( response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments ): void
    {
        this.logToClient( "initializeRequest." );

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsFunctionBreakpoints      = false;
        response.body.supportsEvaluateForHovers        = true;

		this.sendResponse( response );
	}

    //-----------------------------------------------------------
	protected launchRequest( response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments ) : void
    {
        this.logToClient( "launchRequest" );

        this._args          = args;
        this._sourceRoot    = this.normPath( args.localRoot );

        this.beginInit( response, args.host || "127.0.0.1", args.port || 9091 );
	}

    //-----------------------------------------------------------
    protected attachRequest( response: DebugProtocol.AttachResponse, args: LaunchRequestArguments ) : void
    {
        this.logToClient( "attachRequest" );

        this._args          = args;
        this._sourceRoot    = this.normPath( args.localRoot );

        this.beginInit( response, args.host || "127.0.0.1", args.port || 9091 );
    }

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void
	{
        this.logToClient( "disconnectRequest" );

        const timeoutMS = 2000;

        var finished:boolean = false;

         var doDisconnect = () => {

            if( finished )
                return;

            finished = true;

            this.logToClient( "Disconnecing Socket." );
            this._dukProto.disconnect();
            this.sendResponse( response );
        };

        var timeoutID:number = setTimeout( () =>{

            clearTimeout( timeoutID );
            if( finished )
                return;

            this.logToClient( "Detach request took too long. Forcefully disconnecting." );
            doDisconnect();

        }, timeoutMS );


        // Detach request after clearing all the breakpoints
        var doDetach = () => {

            if( finished )
                return;

            this._dukProto.requestDetach().then().catch( e=>{} )
                .then( () => {
                    doDisconnect();
                });
        };


        // Clear all breakpoints
        var sources:SourceFile[] = [];
        for( let k in this._sources )
        {
            let src:SourceFile = this._sources[k];
            if( src.breakpoints && src.breakpoints.length > 0 )
                sources.push( src );
        }

        var clearSource = ( i:number ) => {

            if( i >= sources.length )
            {
                // finished
                doDetach();
                return;
            }

            this.clearBreakPoints( sources[i] )
                .then().catch( err =>{}).then( () =>{
                    clearSource( i+1 );
                });
        };

        if( sources.length > 0 )
        {
            this.logToClient( "Clearing breakpoints on target." );
            clearSource(0);
        }
        else
        {
            this.logToClient( "No breakpoints. Detaching immediately." );
            doDetach();
        }
    }

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void
	{
        this.logToClient( "setBreakPointsRequest" );

        // Try to find the source file
        var src:SourceFile = this.mapSourceFile( this.getSourceNameByPath( args.source.path ) );

        if( !src )
        {
            this.logToClient( "Unknown source file: " + args.source.path );
            this.sendErrorResponse( response, 0, "SetBreakPoint failed" );
            return;
        }

        var inBreaks  = args.breakpoints;        // Should be an array of "SourceBreakpoint"s
        var outBreaks = new Array<Breakpoint>();

        var doRequest = ( i:number ) =>
        {
            if( i >= inBreaks.length )
            {
                response.body = { breakpoints: outBreaks };
                this.sendResponse( response );
                return;
            }

            var bp   = inBreaks[i];
            let line = this.convertDebuggerLineToClient( bp.line );
            let name = this.normPath( src.name );

            this._dukProto.requestSetBreakpoint( name, line )
                .then( resp => {

                /// Save the breakpoints to the file source
                let r = <DukAddBreakResponse>resp;

                src.breakpoints.push( new DukBreakPoint( r.index, bp.line ) );
                //this.logToClient( "BRK: " + r.index + " ( " + bp.line + ")");

                outBreaks.push( new Breakpoint( true, bp.line ) );

            }).catch( err => {
                // Simply don't add the breakpoint if it failed.
            }).then(() => {

                // Go to the next one
                doRequest( i+1 );
            });

        };

        // TODO: Only delete breakpoints that have been removed, not all the cached breakpoints.
        this.clearBreakPoints( src ).then().catch( e => {} ).then( () => {
            doRequest(0);
        });
    }

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void
	{
        this.logToClient( "threadsRequest" );

        response.body = {
            threads:  [ new Thread( DukDebugSession.THREAD_ID, "Main Thread") ]
        };

        this.sendResponse( response );
    }

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void
	{
        this.logToClient( "stackTraceRequest" );

        // Make sure we're paused
        if( !this._dbgState.paused )
        {
            this.requestFailedResponse( response,
                "Attempted to get stack trace while in running." );
            return;
        }

        var dukframes;

        // Grab callstack from duktape
        this._dukProto.requestCallStack()
        .then( ( val:DukGetCallStackResponse ) => {
			dukframes = val.callStack.map(function (entry, index) {
                let srcFile:SourceFile = this.mapSourceFile( entry.fileName );
                let line = this.convertDebuggerLineToClient( entry.lineNumber );

                // Save stack frame with local vars
                let frame = new DukStackFrame( srcFile, entry.fileName, entry.funcName,
                                               line, entry.pc, -index - 1, null );

                frame.handle = this._dbgState.stackFrames.create( frame );
                return(frame);
			}, this);

            // Apply constructors to functions
            return this.sequentialPromises(dukframes, (frame, index) => {
            		return this.getObjectConstructorByName( "this", frame.depth )
				            .then( ( c:string ) => {
                				frame.klass = c;
				            });
				}, this);

        }).then( ( ) => {
			let frames = dukframes.map(function (frame) {
				// Find source file
				let srcFile = frame.source;
				let src     = null;
				if( srcFile )
					src = new Source( srcFile.name, srcFile.path, srcFile.id );

				let klsName  = frame.klass == "" ? "" : frame.klass + ".";
				let funcName = frame.funcName == "" ? "(anonymous function)" : frame.funcName + "()";

				//i: number, nm: string, src: Source, ln: number, col: number
				return new StackFrame( frame.handle,
								 klsName + funcName + " : " + frame.pc,
								 src, frame.lineNumber, frame.pc );
			}, this);

			response.body = { stackFrames: frames };
			this.sendResponse( response );
        }).catch( ( err ) => {
            this.logToClient( "Stack trace failed: " + err );

            response.body = { stackFrames: [] };
            this.sendResponse( response );
        });
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void
	{
        this.logToClient( "scopesRequest" );

        const stackFrameHdl = args.frameId;
        let   stackFrame    = this._dbgState.stackFrames.get( stackFrameHdl );

        // Prepare DukScope objects
        const names     = [ "Local", /*"Closure",*/ "Global" ];
        let   dukScopes = new Array<DukScope>(names.length);

        for( let i=0; i < names.length; i++ )
        {
            let scope    = new DukScope( names[i], stackFrame, null );
            scope.handle = this._dbgState.scopes.create( scope );

            dukScopes[i] = scope;
        }
        stackFrame.scopes = dukScopes;

        // Ask Duktape for the scope property keys for this stack frame
		const scopes = new Array<Scope>();
		for( let i=0; i < dukScopes.length; i++ ) {
			scopes.push( new Scope( dukScopes[i].name,
						 dukScopes[i].handle, dukScopes[i].name == "Global" ) );
		}

		response.body = {
			scopes: scopes
		};
		this.sendResponse(response);
    }

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void
	{
        this.logToClient( "variablesRequest" );

		response.body = { variables: [] };
		const scope = this._dbgState.scopes.get(args.variablesReference);
		if (!scope) {
			this.sendResponse(response);
		} else {
			this._dukProto.requestLocalVariables(scope.name == "Global" ? 0 : scope.stackFrame.depth)
			.then( (resp:DukGetLocalsResponse) => {
					resp.vars.forEach(function(e) {
						e.variablesReference = 0;
						if (typeof e.value === "undefined")
							return;
						if (typeof e.value === "string")
							e.type = "string"
						else if (typeof e.value === "object") {
							e.value = "[Object]";
							e.type = "object"
						} else if (typeof e.value === "number") {
							e.value = "" + e.value;
							e.type = "float";
						} else {
							e.value = "" + e.value;
							e.type = "string";
						}
						response.body.variables.push(e);
					});
				this.sendResponse(response);
			}).catch( ( err ) => {
				this.logToClient( "Variable request failed: " + err );

				this.sendResponse( response );
			});
		}
	}

	protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void
	{
        this.logToClient( "pauseRequest" );

        if( this._dbgState.paused ) {
            this.requestFailedResponse( response, "Already paused." );
         }  else {
            this._dukProto.requestPause().then( ( val ) => {
                // A status notification should follow shortly
                this.sendResponse( response );
        	    this.sendEvent( new StoppedEvent( "step", DukDebugSession.THREAD_ID ) );

            }).catch( (err) => {
                this.requestFailedResponse( response );
            });
        }
    }

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void
	{
        this.logToClient( "continueRequest" );

        if( !this._dbgState.paused ) {
            this.logToClient( "Can't continue when not paused" );
            this.requestFailedResponse( response, "Not paused." );
         }  else {
            this._dukProto.requestResume().then( ( val ) => {

                // A status notification should follow shortly
                this.sendResponse( response );

            }).catch( (err) => {

                this.requestFailedResponse( response );
            });
        }
    }

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void
	{
        this.logToClient( "nextRequest" );

        if( !this._dbgState.paused ) {
            this.logToClient( "Can't step over when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._dukProto.requestStepOver().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            this.sendEvent( new StoppedEvent( "step", DukDebugSession.THREAD_ID ) );

        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void
	{
        this.logToClient( "stepBackRequest" );
		this.sendResponse(response);
	}

    protected stepInRequest (response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments ): void
    {
        this.logToClient( "stepInRequest" );

        if( !this._dbgState.paused ) {
            this.logToClient( "Can't step into when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._dukProto.requestStepInto().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            this.sendEvent( new StoppedEvent( "step", DukDebugSession.THREAD_ID ) );

        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }

    // StepOut
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
    {
        this.logToClient( "stepOutRequest" );

        if( !this._dbgState.paused ) {
            this.logToClient( "Can't step out when not paused" );
            this.requestFailedResponse( response, "Not paused." );
            return;
        }

        this._dukProto.requestStepOut().then( ( val ) => {
            // A status notification should follow shortly
            this.sendResponse( response );
            this.sendEvent( new StoppedEvent( "step", DukDebugSession.THREAD_ID ) );

        }).catch( (err) => {
            this.requestFailedResponse( response );
        });
    }

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void
	{
        this.logToClient( "evaluateRequest");

		let frame = this._dbgState.stackFrames.get( args.frameId );
		if( !frame ) {
			this.requestFailedResponse( response, "Failed to find stack frame: " + args.frameId );
			return;
		}

		this._dukProto.requestEval( args.expression, frame.depth )
		.then( (resp:DukEvalResponse) => {
			if( !resp.success )
				this.requestFailedResponse( response, "Failed to evaluate: " + args.expression );
			else {
				response.body = {
					result: String( resp.result ),
					variablesReference: 0 // frame.scopes[0].properties.handle
				};
				this.sendResponse( response );
			}

		}).catch( (err) => {
			this.requestFailedResponse( response, "Failed to evaluate: " + args.expression );
		});
	}

    // Clear all breakpoints for a source file
    private clearBreakPoints( src:SourceFile ) : Promise<any>
    {
        if( src.breakpoints.length < 1 )
            return Promise.resolve();

        // TODO: Check a flag on the source file to see if it's busy setting/removing
        // breakpoints? To make sure that no brakpoint attempts are done while working
        // on a request still?

        var bpList = src.breakpoints;
        src.breakpoints = new Array<DukBreakPoint>();

        // Duk keeps an index-based breakpoints,
        // so we must start from the top-most,
        // otherwise we'll end-up with invalid breakpoint indices
        return this.reverseSequentialPromises(bpList, function (bp) {
        		return this._dukProto.requestRemoveBreakpoint( bp.dukIdx )
        	}, this);
    }

    private removeAllTargetBreakpoints() : Promise<any>
    {
        this.logToClient( "removeAllTargetBreakpoints" );

        return this._dukProto.requestListBreakpoints()
            .then( (resp) : Promise<any> => {
                let r = <DukListBreakResponse>resp;
				return this.countingPromise(r.breakpoints.length - 1, -1, function (index) {
						return this._dukProto.requestRemoveBreakpoint(index)
					}, this);
            } );
    }

    // Returns the object constructor. If it's the global object,
    // or an error occurrs, then it return an empty string.
    private getObjectConstructorByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "(" + prefix + '.constructor.toString().match(/\\w+/g)[1])';

		return this.serializePromises([
			function() : Promise<any> { return this.isGlobalObjectByName( prefix, stackDepth ) },
			function(isGlobal) : Promise<any> {
				if( isGlobal )
					return Promise.resolve("");

				// Not global object, try to get the constructor name
				return this._dukProto.requestEval( exp, stackDepth )
			},
			function(resp) : Promise<any> {
                let r = <DukEvalResponse>resp;
                return Promise.resolve(r.success ? String(r.result) : "");
			}
		], this).catch( err => "" );
    }

    //-----------------------------------------------------------
    // Find the constructor name for a given heap pointer
    // Returns "{ Null }" when the pointer is null or
    // Object upon any failure
    //-----------------------------------------------------------
    private getObjectConstructorName( targetPtr:Duk.TValPointer ) : Promise<string>
    {
        if( targetPtr.isNull() )
            return Promise.resolve( "{ Null }" );

		return this.serializePromises([
			function() : Promise<any> { return this._dukProto.requestInspectHeapObj( targetPtr, 0 ) },
			function(r:DukInspectHeapObjResponse) : Promise<any> {
				let proto = ArrayX.firstOrNull( r.properties, (v) => v.key == "internal_prototype" );
				if( !proto )
					return Promise.reject( null );

				 // Find constructor property
				return this._dukProto.requestInspectHeapObj( (<Duk.TValObject>proto.value).ptr, 0 );
			},
			function(r:DukInspectHeapObjResponse) : Promise<any> {
                let ctorProp = ArrayX.firstOrNull( r.properties, (v) => v.key == "constructor" );
                if( !ctorProp )
                    return Promise.reject( null );

                // Find name property
                return this._dukProto.requestInspectHeapObj( (<Duk.TValObject>ctorProp.value).ptr, 0 );
 			},
			function(r:DukInspectHeapObjResponse) : Promise<any> {
				let nameProp = ArrayX.firstOrNull( r.properties, (v) => v.key == "name" );
				if( !nameProp )
					return Promise.reject( null );

				return Promise.resolve(String( nameProp.value ));
			}
		], this).catch( (err) => "Object" );
    }

    // Returns true if the target prefix evaluates to the global
    // object. It rejects upon failure.
    private isGlobalObjectByName( prefix:string, stackDepth:number ) : Promise<any>
    {
        let exp = "String(" + prefix + ")";

        return this._dukProto.requestEval( exp, stackDepth )
        .then(
             (resp) => {

                let r = <DukEvalResponse>resp;
                if( !r.success )
                    return Promise.reject( "failed" );
                else
                {
                    let isglob = <string>r.result === "[object global]" ? true : false;
                    return <any>isglob;
                }
            },

            ( err ) => { Promise.reject( err ) }
        );
    }

	private serializePromises (list, that) : Promise<any>
	{
		return list.reduce(function(pacc, fn) {
				return pacc.then(function(arg) { fn.call(that, arg) });
			}, Promise.resolve());
	}

	private sequentialPromises (array, fn, that) : Promise<any>
	{
		return this.countingPromise(0, array.length, function (index) {
			return(fn.call(this.t, this.a[index], index));
		}, { t: that, a: array });
	}

	private reverseSequentialPromises (array, fn, that) : Promise<any>
	{
		return this.countingPromise(array.length - 1, -1, function (index) {
			return(fn.call(this.t, this.a[index], index));
		}, { t: that, a: array });
	}

	private countingPromise (start, stop, fn, that) : Promise<any>
	{
		if (start == stop)
			return Promise.resolve();

		let ctx = {
			fn: fn,
			that: that,
			stop: stop,
			step: (start < stop) ? 1 : -1,
			resolve: undefined,
			reject: undefined
		};
		let p = new Promise<any>(function(resolve, reject) { ctx.resolve = resolve; ctx.reject = reject; });

        function process (index) {
            if (index == this.stop) {
				this.resolve();
            } else {
				this.fn.call(this.that, index)
				.catch( ( ) => { } )
    	        .then( ( ) => {
        	        process.call(this, index + this.step);
            	});
			}
        };

		process.call(ctx, start);
		return(p);
	}

    private mapSourceFile( name:string ) : SourceFile
    {
        if( !name )
            return null;

        name = this.normPath( name );

        let sources = this._sources;

        // Attempt to find it first
        for( let k in sources )
        {
            let val:SourceFile = sources[k];
            if( val.name == name )
                return val;
        }

        let path = this.normPath( Path.join( this._sourceRoot, name ) );
       if( !FS.existsSync( path ) )
           return null;

        let src:SourceFile = new SourceFile();
        src.id   = this._dbgState.nextSrcID ++;
        src.name = name;
        src.path = path;

        sources[src.id] = src;
        return src;
    }

    private getSourceNameByPath( path:string ) : string
    {
        path = this.normPath( path );

        if( path.indexOf( this._sourceRoot ) != 0 )
            return undefined;

        return path.substr( this._sourceRoot.length+1 );
    }

    private requestFailedResponse( response:DebugProtocol.Response, msg?:any ) : void
    {
        msg = msg ? msg.toString() : "";

        msg = "Request failed: " + msg;
        this.logToClient( "ERROR: " + msg );
        this.sendErrorResponse( response, ErrorCode.RequestFailed, msg );
    }

    private logToClient( msg:string ) : void
    {
    //    this.sendEvent( new OutputEvent( msg + "\n" ) );

        console.log( msg );
    }

    private normPath( path:string ) : string
    {
        path = Path.normalize( path );
        path = path.replace(/\\/g, '/');
        return path;
    }

}

DebugSession.run(DukDebugSession);
