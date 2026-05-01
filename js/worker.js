
// import { generateUUID } from "../util/actions.js";

export const createWorker = () =>
{
  // trampolining to work around worker CORS issue
  // see https://github.com/evanw/esbuild/issues/312#issuecomment-1025066671
  const workerPromise = import( "https://www.vzome.com/modules/vzome-worker-static.js" )
    .then( module => {
      const blob = new Blob( [ `import "${module.WORKER_ENTRY_FILE_URL}";` ], { type: "text/javascript" } );
      const worker = new Worker( URL.createObjectURL( blob ), { type: "module" } );
      return new Promise( resolve => {
        worker .onmessage = ( { data } ) => {
          // This makes sure we don't post any messages to the worker until it is initialized.
          //  Making sure the design controller is created is separate!
          // console.log( 'got response from worker: ', data );
          worker .onmessage = onWorkerMessage;
          resolve( worker );
        };
        worker .postMessage( { type: 'WORKER_PROBE' } );
      } );
    } );

  const postMessage = event =>
  {
      workerPromise.then( worker => {
        // console.log( `Message sending to worker: ${JSON.stringify( event, null, 2 )}` );
        worker .postMessage( event );  // send them all, let the worker filter them out
      } )
      .catch( error => {
        console.log( error );
        console.log( "The worker is not available" );
        onWorkerError( 'The worker is not available.  Module workers are supported in the latest versions of most browsers.  Please update your browser.' );
      } );
  }

  // const requestPromises = {};

  // const postRequest = ( request ) =>
  // {
  //   const requestId = generateUUID();
  //   return new Promise( ( resolve, reject ) => {
  //     requestPromises[ requestId ] = { resolve, reject };
  //     postMessage( { ...request, requestId } );
  //   } );
  // }
  
  
  const subscribers = [];

  const subscribe = subscriber => subscribers .push( subscriber );

  const unsubscribe = subscriber =>
  {
    const index = subscribers .indexOf( subscriber );
    if (index > -1) { // only splice array when item is found
      subscribers .splice( index, 1 ); // 2nd parameter means remove one item only
    }
  }

  const subscribeFor = ( type, callback ) =>
  {
    const subscriber = {
      onWorkerError: error => {
        console.log( error );   // TODO: handle the errors in a way the user can see
      },
      onWorkerMessage: data => {
        if ( type === data.type )
          callback( data.payload );
      }
    }
    subscribe( subscriber );
    return () => unsubscribe( subscriber );
  }

  const onWorkerMessage = message =>
  {
    const { requestId } = message.data;
    if ( !! requestId ) {
      requestPromises[ requestId ] .resolve( message.data );
      return;
    }
    subscribers .forEach( subscriber => subscriber .onWorkerMessage( message.data ) );
  }
  const onWorkerError = message =>
  {
    const { requestId } = message;
    if ( !! requestId ) {
      requestPromises[ requestId ] .reject( message );
      return;
    }
    subscribers .forEach( subscriber => subscriber .onWorkerError( message ) );
  }

  return { postMessage, subscribe, subscribeFor, unsubscribe, /*postRequest,*/};
}

