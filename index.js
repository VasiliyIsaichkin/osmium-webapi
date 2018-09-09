const Events = require('osmium-events');
const tools = require('osmium-tools');

class WebApi extends Events {
	constructor(socket, isServer = false, options) {
		super({
			separated: true
		});

		this.isServer = isServer;

		this.options = Object.assign({
			prefix: 'webApi'
		}, options);

		this._init();

		this.socket = socket;
		this.socketEvents = new Events();

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
		let packet = {
			id,
			name,
			args,
			version: this.options.version
		};

		await tools.iterate(this.middlewaresOut, async (mwFn) => packet = await mwFn(packet, this.socket, true));

		this.socket.emit(this.options.cmdToTarget, packet);
		return promise;
	}

	async incomingCmdHandler(packet) {
		if (!tools.isObject(packet)) return;
		if (!packet.name || !tools.isGUID(packet.id) || packet.version !== this.options.version) return;
		let origName = packet.name;
		let origId = packet.id;
		await tools.iterate(this.middlewaresInc, async (mwFn) => packet = await mwFn(packet, this.socket, true));
		if (packet === null) {
			this.socket.emit(this.options.cmdFromTargetRet, {
				id     : origId,
				name   : origName,
				args   : null,
				version: this.options.version
			});
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
		await tools.iterate(this.middlewaresInc, async (mwFn) => packet = await mwFn(packet, this.socket, false));
		if (!tools.isObject(packet)) return;
		if (!tools.isGUID(packet.id) && packet.version !== this.options.version) return;

		this.socketEvents.emit(packet.id, packet.args);
	}

	async incomingCmdReturnHandler(name, mwConfig, ret) {
		if (!tools.isObject(ret) || !mwConfig.webApiPacketId) return;
		const args = Object.keys(ret).length === 1
			? ret[Object.keys(ret)[0]]
			: tools.objectToArray(ret);
		let packet = {
			id     : mwConfig.webApiPacketId,
			name,
			args,
			version: this.options.version
		};
		await tools.iterate(this.middlewaresOut, async (mwFn) => packet = await mwFn(packet, this.socket, false));

		this.socket.emit(this.options.cmdFromTargetRet, packet);
	}
}

class WebApiServer extends Events {
	constructor(io, options) {
		super(true);
		this.options = Object.assign({
			emitTimeout    : 5000,
			clientProcessor: false
		}, options);

		this.handlers = {};
		this.use((...args) => this.emitHandler(...args));

		this._middlewaresInc = [];
		this._middlewaresOut = [];

		io.on('connection', (socket) => this.registerHandler(socket));
	};

	registerMiddlewareInc(fn) {
		this._middlewaresInc.push(fn);
	}

	registerMiddlewareOut(fn) {
		this._middlewaresOut.push(fn);
	}

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
		socket.on('disconnect', () => this.unRegisterHandelr(socket));
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