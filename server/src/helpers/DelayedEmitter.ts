import SocketIO from 'socket.io';
import log from 'electron-log';

/**
 * Wraps around SocketIO.Server and queues events until the websocket connection
 * to the client is established. Events sent after the connection is established
 * are sent directly without delay.
 */
export default class DelayedEmitter {
    constructor(private websocketServer?: SocketIO.Server) {
        log.debug(`DelayedEmitter: Initialized"`);
        if (this.websocketServer) {
            this.websocketServer.on('connection', this.onConnection);
        }
    }

    private eventQueue: {
        /**
         * The arguments of the event.
         */
        args: any[];
        /**
         * The name of the event.
         */
        name: string;
    }[] = [];
    private isConnected: boolean = false;

    /**
     * Queues the event or emits it directly, depending on whether the websocket
     * is already connected.
     * @param name the name of the event
     * @param args the custom arguments to pass alongside the event name
     */
    public emit = (name: string, ...args: any[]): void => {
        if (this.isConnected) {
            log.debug(`DelayedEmitter: Immediately emitting event "${name}"`);
            this.websocketServer.emit(name, ...args);
        } else {
            log.debug(`DelayedEmitter: Queueing event "${name}"`);
            this.eventQueue.push({ name, args });
        }
    };

    public setWebsocket = (websocket: SocketIO.Server): void => {
        log.debug(`DelayedEmitter: Set websocket`);
        this.websocketServer = websocket;
        this.websocketServer.on('connection', this.onConnection);
    };

    private emitQueue = (): void => {
        log.debug('DelayedEmitter: Emitting queued events');
        for (const event of this.eventQueue) {
            this.websocketServer.emit(event.name, ...event.args);
        }
        this.eventQueue = [];
    };

    private onConnection = () => {
        log.debug('DelayedEmitter: Websocket connected');
        this.isConnected = true;
        this.emitQueue();
    };
}