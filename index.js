const Events = require('osmium-events');
const tools = require('osmium-tools');

class WebApiProto extends Events {
	constructor(mode, isServer) {
		super(mode);
		this._middlewaresInc = [];
		this._middlewaresOut = [];
		this._onConnect = [];
		this._onDisconnect = [];

		this.isServer = isServer;
	}

	makePacket(id, name, args) {
		return {
			id,
			name,
			args,
			version: this.options.version
		};
	}

	registerMiddlewareInc(fn) {
		this._middlewaresInc.push(fn);
	}

	registerMiddlewareOut(fn) {
		this._middlewaresOut.push(fn);
	}

	onConnect(fn) {
		this._onConnect.push(fn);
	}

	onDisconnect(fn) {
		this._onDisconnect.push(fn);
	}
}

class WebApi extends WebApiProto {
	constructor(socket, isServer = false, options) {
		super({
			separated: true
		});

		this.options = Object.assign({
			prefix: 'webApi'
		}, options);

		this._init();

		this.socket = socket;
		this.socketEvents = new Events();
		this.socket.on('connect', () => tools.iterate(this._onConnect, (fn) => fn(this.socket)));
		this.socket.on('disconnect', () => tools.iterate(this._onDisconnect, (fn) => fn(this.socket)));

		//Outgoing command
		this.use(async (...args) => await this.cmdHandler(...args));
		this.socket.on(this.options.cmdToTargetRet, async (packet) => await this.cmdReturnHandler(packet));

		//Incoming command
		this.socket.on(this.options.cmdFromTarget, async (packet) => await this.incomingCmdHandler(packet));
		this.useAfter(async (...args) => await this.incomingCmdReturnHandler(...args));
	}

	_init() {
		const _eventName = (isServer, cmd) =>
			`${this.options.prefix}|${isServer ? 's' : 'c'}|${cmd ? 'c' : 'r'}`;

		Object.assign(this.options, {
			version         : 2,
			cmdToTarget     : _eventName(this.isServer, true),
			cmdToTargetRet  : _eventName(this.isServer, false),
			cmdFromTarget   : _eventName(!this.isServer, true),
			cmdFromTargetRet: _eventName(!this.isServer, false)
		});

		this.middlewaresInc = [];
		this.middlewaresOut = [];
	}

	registerMiddlewareInc(fn) {
		this.middlewaresInc.push(fn);
	}

	registerMiddlewareOut(fn) {
		this.middlewaresOut.push(fn);
	}

	async cmdHandler(name, options, ...args) {
		if (options.skipWebApiHandler) return tools.nop$(); //incomingCmdHandler via emitEx bypass

		const id = tools.GUID();
		const promise = new Promise((resolve) => {
			//@todo: add garbage collecotor here (delete uncalled once's after timeout)
			this.socketEvents.once(id, (ret) => {
				resolve({ret});
			});
		});

		let packet = this.makePacket(id, name, args);

		await tools.iterate(this.middlewaresOut, async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, true) : false);
		if (tools.isObject(packet)) this.socket.emit(this.options.cmdToTarget, packet);

		return promise;
	}

	async incomingCmdHandler(packet) {
		if (!tools.isObject(packet)) return;
		if (!packet.name || !tools.isGUID(packet.id) || packet.version !== this.options.version) return;
		let origName = packet.name;
		let origId = packet.id;
		await tools.iterate(this.middlewaresInc, async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, true) : false);
		if (packet === null) {
			this.socket.emit(this.options.cmdFromTargetRet, this.makePacket(origId, origName, null));
			return;
		}
		if (!tools.isObject(packet)) return;
		if (!packet.name || !tools.isGUID(packet.id) || packet.version !== this.options.version) return;

		await this.emitEx(packet.name, true, {
			skipWebApiHandler: true,
			webApiPacketId   : packet.id
		}, ...(tools.isArray(packet.args) ? packet.args : [packet.args]));
	}

	async cmdReturnHandler(packet) {
		await tools.iterate(this.middlewaresInc, async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, false) : false);
		if (!tools.isObject(packet)) return;
		if (!tools.isGUID(packet.id) && packet.version !== this.options.version) return;

		this.socketEvents.emit(packet.id, packet.args);
	}

	async incomingCmdReturnHandler(name, mwConfig, ret) {
		if (!tools.isObject(ret) || !mwConfig.webApiPacketId) return;
		const args = Object.keys(ret).length === 1
			? ret[Object.keys(ret)[0]]
			: tools.objectToArray(ret);
		let packet = this.makePacket(mwConfig.webApiPacketId, name, args);

		await tools.iterate(this.middlewaresOut, async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, false) : false);
		if (!tools.isObject(packet)) return;

		this.socket.emit(this.options.cmdFromTargetRet, packet);
	}
}

class WebApiServer extends WebApiProto {
	constructor(io, options) {
		super(true, true);
		this.options = Object.assign({
			emitTimeout    : 5000,
			clientProcessor: false
		}, options);

		this.handlers = {};
		this.use((...args) => this.emitHandler(...args));

		io.on('connection', (socket) => {
			this.registerHandler(socket);
			tools.iterate(this._onConnect, (fn) => fn(socket));
		});
	};

	async emitHandler(name, options, ...args) {
		let promises = [];
		if (options.fromMapper) return;
		tools.iterate(this.handlers, (handler, hid) => {
			promises.push(new Promise(async (resolve) => {
				setTimeout(() => resolve({timeout: true, hid}), this.options.emitTimeout);
				resolve({ret: await handler.emit(name, ...args), timeout: false, hid});
			}));
		});
		const ret = tools.iterate(await Promise.all(promises), (row, _, iter) => {
			iter.key(row.hid);
			return row.timeout ? null : row.ret;
		}, {});
		return {ret};
	}

	registerHandler(socket) {
		socket.on('disconnect', () => {
			tools.iterate(this._onDisconnect, (fn) => fn(socket));
			this.unRegisterHandelr(socket);
		});
		let webApiInst;
		if (!this.options.clientProcessor) {
			webApiInst = new WebApi(socket, true, this.options);
			webApiInst.middlewaresInc = this._middlewaresInc;
			webApiInst.middlewaresOut = this._middlewaresOut;
		}

		this.handlers[socket.id] = this.options.clientProcessor ? this.options.clientProcessor(socket) : webApiInst;
		this.handlers[socket.id].mapEvents(this);
	};

	unRegisterHandelr(socket) {
		delete this.handlers[socket.id];
	}
}

class WebApiClient extends WebApi {
	constructor(socket, options = {}) {
		super(socket, !!options.isServer, options);
	}

	ready() {
		return new Promise((resolve) => this.socket.on('connect', resolve));
	}
}

module.exports = {
	WebApi,
	WebApiServer,
	WebApiClient
};