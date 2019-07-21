const Events = require('osmium-events');
const oTools = require('osmium-tools');
const {Serialize, tools} = require('osmium-serializer');

class WebApiProto extends Events {
	constructor(mode, isServer) {
		super(mode);
		this.middlewaresInc = [];
		this.middlewaresOut = [];
		this.middlewaresIncBefore = [];
		this.middlewaresOutBefore = [];
		this._onConnect = [];
		this._onDisconnect = [];

		this.serializer = Serialize.serializer;
		this.deserializer = Serialize.deserializer;
		this.packetSchema = ['version', 'id', 'name', 'args'];

		this.isServer = isServer;
	}

	useCoder(val) {
		Serialize.use(val);
	}

	makePacket(id, name, args) {
		return {
			version: this.options.version,
			id,
			name,
			args
		};
	}

	registerMiddlewareInc(fn) {
		this.middlewaresInc.push(fn);
	}

	registerMiddlewareOut(fn) {
		this.middlewaresOut.push(fn);
	}

	registerMiddlewareIncBefore(fn) {
		this.middlewaresIncBefore.unshift(fn);
	}

	registerMiddlewareOutBefore(fn) {
		this.middlewaresOutBefore.unshift(fn);
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
		}, isServer);

		this.options = Object.assign({
			prefix: ''
		}, options);

		const _eventName = (isServer, cmd) =>
			`${this.options.prefix}${isServer ? (cmd ? 'a' : 'b') : (cmd ? 'c' : 'd')}`;

		Object.assign(this.options, {
			version         : 4,
			cmdToTarget     : _eventName(this.isServer, true),
			cmdToTargetRet  : _eventName(this.isServer, false),
			cmdFromTarget   : _eventName(!this.isServer, true),
			cmdFromTargetRet: _eventName(!this.isServer, false)
		});

		this.socket = socket;
		this.socketEvents = new Events();
		this.socket.on('connect', () => oTools.iterate(this._onConnect, (fn) => fn(this.socket)));
		this.socket.on('disconnect', () => oTools.iterate(this._onDisconnect, (fn) => fn(this.socket)));

		//Outgoing command
		this.use(async (...args) => await this.cmdHandler(...args));
		this.socket.on(this.options.cmdToTargetRet, async (packet) => await this.cmdReturnHandler(packet));

		//Incoming command
		this.socket.on(this.options.cmdFromTarget, async (packet) => await this.incomingCmdHandler(packet));
		this.useAfter(async (...args) => await this.incomingCmdReturnHandler(...args));
	}

	async cmdHandler(name, options, ...args) {
		if (options.skipWebApiHandler) return oTools.nop$(); //incomingCmdHandler via emitEx bypass

		const getRndI32 = () => tools.int32UToBuf(Math.floor(Math.random() * 0xffffffff));
		const id = tools.base64Encode(Buffer.concat([getRndI32(), getRndI32(), getRndI32(), getRndI32()]));

		const promise = new Promise((resolve) => {
			//@todo: add garbage collecotor here (delete uncalled once's after timeout)
			this.socketEvents.once(id, (ret) => {
				resolve({ret});
			});
		});

		let packet = this.makePacket(id, name, args);
		await oTools.iterate([].concat(this.middlewaresOutBefore, this.middlewaresOut), async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, true) : false);
		if (packet) this.socket.emit(this.options.cmdToTarget, this.serializer.serialize(packet));

		return promise;
	}

	async incomingCmdHandler(packet) {
		packet = this.deserializer.deserialize(packet, this.packetSchema);
		await oTools.iterate([].concat(this.middlewaresIncBefore, this.middlewaresInc), async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, true) : false);
		if (oTools.isArray(packet)) {
			this.socket.emit(this.options.cmdFromTargetRet, this.serializer.serialize(this.makePacket(packet.id, packet.name, packet[0])));
			return;
		}

		if (!oTools.isObject(packet)) return;
		if (!packet.name || !oTools.isString(packet.id) || packet.version !== this.options.version) return;

		await this.emitEx(packet.name, true, {
			skipWebApiHandler: true,
			webApiPacketId   : packet.id
		}, ...(oTools.isArray(packet.args) ? packet.args : [packet.args]));
	}

	async cmdReturnHandler(packet) {
		packet = this.deserializer.deserialize(packet, this.packetSchema);
		await oTools.iterate([].concat(this.middlewaresIncBefore, this.middlewaresInc), async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, false) : false);
		if (!oTools.isObject(packet)) return;
		if (!oTools.isString(packet.id) && packet.version !== this.options.version) return;

		this.socketEvents.emit(packet.id, packet.args);
	}

	async incomingCmdReturnHandler(name, mwConfig, ret) {
		if (!oTools.isObject(ret) || !mwConfig.webApiPacketId) return;
		const args = Object.keys(ret).length === 1
		             ? ret[Object.keys(ret)[0]]
		             : oTools.objectToArray(ret);
		let packet = this.makePacket(mwConfig.webApiPacketId, name, args);

		await oTools.iterate([].concat(this.middlewaresOutBefore, this.middlewaresOut), async (mwFn) => packet = packet !== false ? await mwFn(packet, this.socket, false) : false);

		this.socket.emit(this.options.cmdFromTargetRet, this.serializer.serialize(packet));
	}
}

class WebApiServer extends WebApiProto {
	constructor(io, options) {
		super(true, true);
		this.options = Object.assign({
			emitTimeout    : 30000,
			clientProcessor: false
		}, options);

		this.handlers = this.options.handlers || {};
		this.use((...args) => this.emitHandler(...args));

		if (!io) return;
		io.on('connection', (socket) => {
			this.registerHandler(socket);
			oTools.iterate(this._onConnect, (fn) => fn(socket));
		});
	};

	async emitHandler(name, options, ...args) {
		if (options.fromMapper) return;
		let promises = oTools.iterate(this.handlers, (handler, hid) => {
			return new Promise(async (resolve) => {
				const tId = setTimeout(() => resolve({timeout: true, hid}), this.options.emitTimeout);
				resolve({ret: await handler.emit(name, ...args), timeout: false, hid});
				clearTimeout(tId);
			});
		}, []);

		const ret = oTools.iterate(await Promise.all(promises), (row, _, iter) => {
			iter.key(row.hid);
			return row.timeout ? null : row.ret;
		}, {});
		return {ret};
	}

	to(dest) {
		const handlers = oTools.iterate(oTools.toArray(dest), (row, _, iter) => {
			const sId = oTools.isObject(row) ? row.id : oTools.isFunction(row) ? row(this) : row;
			if (!this.handlers[sId]) return;
			iter.key(sId);
			return this.handlers[sId];
		}, {});
		return new WebApiServer(false, {handlers});
	}

	registerHandler(socket) {
		socket.on('disconnect', () => {
			oTools.iterate(this._onDisconnect, (fn) => fn(socket));
			this.unRegisterHandelr(socket);
		});

		const clientProcessor = this.options.clientProcessor
		                        ? this.options.clientProcessor(socket, true, this.options)
		                        : new WebApi(socket, true, this.options);

		clientProcessor.middlewaresInc = [].concat(clientProcessor.middlewaresInc, this.middlewaresInc);
		clientProcessor.middlewaresIncBefore = [].concat(clientProcessor.middlewaresIncBefore, this.middlewaresIncBefore);
		clientProcessor.middlewaresOut = [].concat(clientProcessor.middlewaresOut, this.middlewaresOut);
		clientProcessor.middlewaresOutBefore = [].concat(clientProcessor.middlewaresOutBefore, this.middlewaresOutBefore);
		clientProcessor.mapEvents(this);

		this.handlers[socket.id] = clientProcessor;
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
