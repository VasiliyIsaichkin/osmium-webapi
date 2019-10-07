const Events = require('osmium-events');
const oTools = require('osmium-tools');
const {Serialize, DataCoder, tools} = require('osmium-serializer');

const WebApiProtoVersion = 6;

class WebApiProto extends Events {
	constructor(options, isServer) {
		super();
		this.options = options;
		const mwI = {};
		const mwW = {};
		const mwO = {};
		this.middlewaresInc = mwI;
		this.middlewaresWrap = mwW;
		this.middlewaresOut = mwO;
		this.onConnects = [];
		this.onDisconnects = [];

		this.coder = new DataCoder();
		this.serializer = new Serialize(false, this.coder);
		this.packetSchema = Object.keys(this.makePacket(null, null, null));

		this.isServer = isServer;
		this.PRIORITY = {
			FIRST : 10,
			NORMAL: 1000,
			LAST  : 1990
		};
		this.emitters = {
			meta   : '~M7PN9OehiioEmGFHNU-C4Frvm',
			timeout: '~4AP2K7lq183qFj39fe-UVG5a4'
		};
	}

	useCoder(...args) {
		this.coder.use(...args);
	}

	makePacket(id, name, args) {
		return {
			version: WebApiProtoVersion,
			id,
			name,
			args,
			meta   : {},
			breaked: false
		};
	}

	_makeEmitter(what, id) {
		return {
			emit: async (name, ...args) => await this.emit(name, {what, id}, ...args)
		};
	}

	_registerMiddleware(storage, idx, fn, isAfter) {
		if (oTools.isFunction(idx)) {
			fn = idx;
			idx = this.PRIORITY.NORMAL;
		}
		if (!oTools.isFunction(fn)) return false;

		const id = oTools.UID('%');

		storage[idx] = storage[idx] || [];
		storage[idx].push({
			id,
			fn,
			isAfter
		});

		return id;
	}

	getMiddleware(id) {
		let ret = false;
		const _find = (where) => oTools.iterate(where, (mws, idx, iter1) => oTools.iterate(mws, (mw, pos, iter2) => {
			if (mw.id !== id) return;
			iter1.break();
			iter2.break();
			ret = Object.assign({idx, pos}, mw);
		}));

		_find(this.middlewaresInc);
		if (!ret) _find(this.middlewaresOut);
		return ret;
	}

	middlewareInc(idx, fn, isAfter = null) {
		return this._registerMiddleware(this.middlewaresInc, idx, fn, isAfter);
	}

	middlewareWrap(idx, fn) {
		return this._registerMiddleware(this.middlewaresWrap, idx, fn, true);
	}

	middlewareOut(idx, fn, isAfter = null) {
		return this._registerMiddleware(this.middlewaresOut, idx, fn, isAfter);
	}

	middlewareIncBefore(idx, fn) {
		return this.middlewareInc(idx, fn, false);
	}

	middlewareIncAfter(idx, fn) {
		return this.middlewareInc(idx, fn, true);
	}

	middlewareOutBefore(idx, fn) {
		return this.middlewareOut(idx, fn, false);
	}

	middlewareOutAfter(idx, fn) {
		return this.middlewareOut(idx, fn, true);
	}

	onConnect(fn) {
		this.onConnects.push(fn);
	}

	onDisconnect(fn) {
		this.onDisconnects.push(fn);
	}
}

class WebApi extends WebApiProto {
	constructor(socket, isServer = false, options = {}) {
		super(options, isServer);

		this.options = Object.assign(options, {
			prefix : '',
			timeout: 600000,
			local  : false
		}, options);
		this.isLocal = this.options.local;

		const getEventName = (isServer, cmd) =>
			`${this.options.prefix}${isServer ? (cmd ? 'a' : 'b') : (cmd ? 'c' : 'd')}`;

		this.onceIds = {};

		Object.assign(this.options, {
			version         : WebApiProtoVersion,
			cmdToTarget     : getEventName(this.isServer, true),
			cmdToTargetRet  : getEventName(this.isServer, false),
			cmdFromTarget   : getEventName(!this.isServer, true),
			cmdFromTargetRet: getEventName(!this.isServer, false)
		});

		this.socketEvents = new Events();
		this.socket = false;

		if (!this.isLocal) {
			this.socket = socket;
			this.socket.on('connect', () => oTools.iterate(this.onConnects, (fn) => fn(this.socket)));
			this.socket.on('disconnect', () => oTools.iterate(this.onDisconnects, (fn) => fn(this.socket)));
		}

		//Outgoing command - before
		this.use(async (...args) => await this.outcomingCmdHandler(...args));
		//Outgoing command - after
		if (!this.isLocal) this.socket.on(this.options.cmdToTargetRet, async (packet) => await this.incomingRetHandler(packet));

		//Incoming command - before
		if (!this.isLocal) this.socket.on(this.options.cmdFromTarget, async (packet) => await this.incomingCmdHandler(packet));
		//Incoming command - after
		this.useAfter(async (...args) => await this.outcomingRetHandler(...args));

		setInterval(() => {
			oTools.iterate(this.onceIds, (once, id) => {
				if (once.t >= Date.now()) return;
				this.socketEvents.emit(once.id, []);
				delete this.onceIds[id];
			});
		}, 5000);
	}

	meta(what) {
		return this._makeEmitter(what, this.emitters.meta);
	}

	timeout(ms) {
		return this._makeEmitter(ms, this.emitters.timeout);
	}

	_extractFunctionArgs(fn) {
		try {
			return fn.toString().split('(')[1].split(')')[0].split(',').map((r) => r.split('=')[0].trim());
		} catch (e) {
			return [];
		}
	}

	_injectToArgs(fn, injects, args) {
		let aCnt = 0;

		return oTools.iterate(this._extractFunctionArgs(fn), (arg) => {
			if (arg[0] === '$') {
				const name = injects[arg.substr(1)];
				return !oTools.isUndefined(name) ? name : {};
			}
			aCnt++;

			return args[aCnt - 1];
		}, []);
	}

	async mwIterate(mwStorage, packet, isAfter = false) {
		packet.injects = packet.injects || {};
		Object.assign(packet.injects, {
			packet,
			id          : packet.id,
			name        : packet.name,
			args        : packet.args,
			meta        : packet.meta,
			socket      : this.socket,
			isAfter     : isAfter,
			isBefore    : !isAfter,
			isServer    : this.isServer,
			isLocal     : this.isLocal,
			minddlewares: mwStorage,
			instance    : this,
			mwAffected  : [],
			setArgs     : (args) => packet.args = args,
			setArg      : (idx, val) => packet.args[idx] = val,
			add         : (key, value) => {
				if (oTools.isString(key)) packet.injects[key] = value;
				if (oTools.isObject(key)) Object.assign(packet.injects, key);
			},
			del         : (key) => delete packet.injects[key],
			get         : (key) => packet.injects[key],
			drop        : () => packet.dropped = true,
			break       : (ret) => {
				packet.breaked = true;
				packet.args = [ret];
			},
			skipMw      : () => packet.skipMw = true
		});

		function _update() {
			Object.assign(packet.injects, {
				packet,
				id  : packet.id,
				name: packet.name,
				args: packet.args,
				meta: packet.meta
			});
		}

		_update();

		await oTools.iterate(mwStorage, async (mwRow, idx, iter1) => {
			if (!packet) return iter1.break();

			await oTools.iterate(mwRow, async (mw, _, iter2) => {
				if (mw.isAfter !== null && mw.isAfter !== isAfter) return;
				packet.injects.mwAffected.push(mw.id);
				const ret = await mw.fn.apply(packet.injects, this._injectToArgs(mw.fn, packet.injects, []));
				_update();
				if (!oTools.isUndefined(ret)) {
					packet.breaked = true;
					packet.args = [ret];
				}

				if (packet.skipMw) {
					iter1.break();
					iter2.break();
				}
			});
		});
	}

	filterPacket(packet) {
		return oTools.iterate(this.packetSchema, (idx, _, iter) => {
			iter.key(idx);
			return packet[idx];
		}, {});
	}

	serializePacket(packet) {
		try {
			return this.serializer.serialize(this.filterPacket(packet));
		} catch (e) {
			if (!packet.name) console.log('Error in serializePacket, incorrect packet: ', packet);
			throw new Error(`Cant filter/serialize packet in [${packet.name}], serializer error - ${e}`);
		}
	}

	checkPacket(packet) {
		return oTools.isObject(packet)
		       && oTools.isString(packet.id)
		       && oTools.isString(packet.name)
		       && oTools.isArray(packet.args)
		       && oTools.isObject(packet.meta)
		       && packet.version === WebApiProtoVersion;
	}

	_getEmitterById(id) {
		let ret = false;
		oTools.iterate(this.emitters, (val, idx, iter) => {
			if (val !== id) return;
			iter.break();
			ret = idx;
		});
		return ret;
	}

	async outcomingCmdHandler(name, options, ...args) {
		if (options.skipWebApiHandler) return oTools.nop$(); //incomingCmdHandler via emitEx bypass

		let timeout = this.options.timeout;
		const id = oTools.UID('^');
		const packet = this.makePacket(id, name.trim(), args);

		if (oTools.isObject(args[0]) && args[0].id && !oTools.isUndefined(args[0].what)) {
			const emitter = this._getEmitterById(args[0].id);
			if (emitter) {
				switch (emitter) {
					case 'timeout':
						timeout = args[0].what;
						break;
					case 'meta':
						Object.assign(packet.meta, args[0].what);
						break;
				}
				args.splice(0, 1);
			}
		}

		await this.mwIterate(this.middlewaresOut, packet, false);

		if (!oTools.isObject(packet) || packet.dropped) return new Promise(resolve => resolve(undefined));
		if (packet.breaked) return new Promise(resolve => resolve(packet.args[0]));

		const promise = new Promise((resolve) => {
			const onceId = this.socketEvents.once(id, (ret) => resolve({ret}));
			this.onceIds[onceId] = {t: Date.now() + timeout, id};
		});

		if (packet && !this.isLocal) this.socket.emit(this.options.cmdToTarget, this.serializePacket(packet));
		if (packet && this.isLocal) {
			let ret = await this.emitEx(packet.name, true, {
				skipWebApiHandler: true,
				webApiPacketId   : false
			}, ...(oTools.isArray(packet.args) ? packet.args : [packet.args]));

			ret = oTools.iterate(ret, (row) => row, []);
			if (ret.length === 1) ret = ret[0];
			packet.args = ret;
			await this.incomingRetHandler(this.serializePacket(packet));
		}

		return promise;
	}

	async incomingCmdHandler(rawPacket) {
		let packet = false;
		try {
			packet = this.serializer.deserialize(rawPacket, this.packetSchema);
		} catch (e) { }
		if (!this.checkPacket(packet)) return;

		await this.mwIterate(this.middlewaresInc, packet, false);

		if (!oTools.isObject(packet) || packet.dropped) return;

		if (packet.breaked) {
			await this.outcomingRetHandler(packet.name, {webApiPacketId: packet.id}, {'mwIncBefore': packet.args[0]});
			return;
		}


		return this.middlewareWrap.reverse().reduce(
			(next, middleware) => async () => await middleware.fn(next),
			async () =>
				await this.emitEx(packet.name, true, {
					context          : packet.injects || {},
					preCall          : (cb, args, id) => {
						packet.injects.eventId = id;
						return this._injectToArgs(cb, packet.injects, args);
					},
					skipWebApiHandler: true,
					webApiPacketId   : packet.id
				}, ...packet.args)
		);
	}

	async outcomingRetHandler(name, mwConfig, ret) {
		if (!oTools.isObject(ret) || !mwConfig.webApiPacketId) return;
		const args = Object.keys(ret).length === 1
		             ? ret[Object.keys(ret)[0]]
		             : oTools.objectToArray(ret);
		let packet = this.makePacket(mwConfig.webApiPacketId, name.trim(), [args]);

		await this.mwIterate(this.middlewaresInc, packet, true);

		if (!oTools.isObject(packet) || packet.dropped) return;

		this.socket.emit(this.options.cmdFromTargetRet, this.serializePacket(packet));
	}

	async incomingRetHandler(rawPacket) {
		const packet = this.serializer.deserialize(rawPacket, this.packetSchema);
		if (!this.checkPacket(packet)) return;

		packet.name = packet.name.trim();

		await this.mwIterate(this.middlewaresOut, packet, true);
		if (!oTools.isObject(packet) || packet.dropped) return;
		if (packet.args.length === 1) packet.args = packet.args[0];
		await this.socketEvents.emit(packet.id, packet.args);
	}

}

class WebApiServer extends WebApiProto {
	constructor(io, options) {
		super(options, true);
		this.options = Object.assign({
			emitTimeout    : 30000,
			clientProcessor: false
		}, options);

		this.handlers = this.options.handlers || {};
		this.use((...args) => this.emitHandler(...args));

		if (!io) return;

		io.on('connection', (socket) => {
			this.registerHandler(socket);
			oTools.iterate(this.onConnects, (fn) => fn(socket));
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

	meta(what) {
		return this._makeEmitter(what, this.emitters.meta);
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

	assignMw(clientProcessor) {
		Object.assign(this.middlewaresInc, clientProcessor.middlewaresInc);
		clientProcessor.middlewaresInc = this.middlewaresInc;

		Object.assign(this.middlewaresOut, clientProcessor.middlewaresOut);
		clientProcessor.middlewaresOut = this.middlewaresOut;
	}

	local() {
		const clientProcessor = new WebApi(false, true, {local: true});

		this.assignMw(clientProcessor);
		clientProcessor.mapEvents(this);

		return clientProcessor;
	}

	registerHandler(socket) {
		socket.on('disconnect', () => {
			oTools.iterate(this.onDisconnects, (fn) => fn(socket));
			this.unRegisterHandelr(socket);
		});

		const clientProcessor = this.options.clientProcessor
		                        ? this.options.clientProcessor(socket, true, this.options)
		                        : new WebApi(socket, true, this.options);

		this.assignMw(clientProcessor);
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
