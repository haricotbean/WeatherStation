// Based on the good work by others, mostly Jim Easterbrook on the WH1080 (and derivative) Weather Stations
// available in UK through Maplin at www.maplin.co.uk/p/black-usb-wireless-touchscreen-weather-forecaster-n96gy
// some other resources:
// https://github.com/jim-easterbrook/pywws/blob/master/pywws/WeatherStation.py
// http://www.jim-easterbrook.me.uk/weather/mm/
// http://www.signal11.us/oss/hidapi/
// https://github.com/node-hid/node-hid
const	restify = require('restify'),
		connect = require('connect'),
		HID = require('node-hid');

var wusb = {
	conf: {
		vid: 0x1941, // USB ID
		pid: 0x8021, // USB ID
		tandem: false, // use interval not device update frequency (usually 30 mins)
		interval: 60, // seconds
		recent: 10, // how many fine interval updates to maintain in memory
		debug: 0
	},
	recent: [], // oldest is last
	//
	// a dictionary for accessing info from data
	_map: { // rf = reading format used in circular buffer
		'rf.delay'         : [0, 'ub'], // minutes since last stored reading
        'rf.hum_in'        : [1, 'ub'],
        'rf.temp_in'       : [2, 'ss', 0.1, 1],
        'rf.hum_out'       : [4, 'ub'],
        'rf.temp_out'      : [5, 'ss', 0.1, 1],
        'rf.abs_pressure'  : [7, 'us', 0.1, 1],
        'rf.wind_ave'      : [9, 'wa', 0.1], // in metres/sec
        'rf.wind_gust'     : [10, 'wg', 0.1], // in metres/sec
        'rf.wind_dir'      : [12, 'ub', 22.5], // position from north
        'rf.rain'          : [13, 'us', 0.3, 1], // total rain
        'rf.status'        : [15, 'bf', ['b1','b2','b3','b4','b5','lost_sensor_contact','rain_overflow','b8']],
        // fb = fixed block formats
        'fb.read_period'   : [16, 'ub'],
        'fb.settings_1'    : [17, 'bf', ['temp_in_F', 'temp_out_F', 'rain_in',
                                      'bit3', 'bit4', 'pressure_hPa',
                                      'pressure_inHg', 'pressure_mmHg']],
        'fb.settings_2'    : [18, 'bf', ['wind_mps', 'wind_kmph', 'wind_knot',
                                      'wind_mph', 'wind_bft', 'bit5',
                                      'bit6', 'bit7']],
        'fb.display_1'     : [19, 'bf', ['pressure_rel', 'wind_gust', 'clock_12hr',
                                      'date_mdy', 'time_scale_24', 'show_year',
                                      'show_day_name', 'alarm_time']],
        'fb.display_2'     : [20, 'bf', ['temp_out_temp', 'temp_out_chill',
                                      'temp_out_dew', 'rain_hour', 'rain_day',
                                      'rain_week', 'rain_month', 'rain_total']],
        'fb.alarm_1'       : [21, 'bf', ['bit0', 'time', 'wind_dir', 'bit3',
                                      'hum_in_lo', 'hum_in_hi',
                                      'hum_out_lo', 'hum_out_hi']],
        'fb.alarm_2'       : [22, 'bf', ['wind_ave', 'wind_gust',
                                      'rain_hour', 'rain_day',
                                      'pressure_abs_lo', 'pressure_abs_hi',
                                      'pressure_rel_lo', 'pressure_rel_hi']],
        'fb.alarm_3'       : [23, 'bf', ['temp_in_lo', 'temp_in_hi',
                                      'temp_out_lo', 'temp_out_hi',
                                      'wind_chill_lo', 'wind_chill_hi',
                                      'dew_point_lo', 'dew_point_hi']],
        'fb.timezone'      : [24, 'sb'],
        'fb.unknown_01'    : [25, 'pb'],
        'fb.data_changed'  : [26, 'ub'],
        'fb.data_count'    : [27, 'us'],
        'fb.display_3'     : [29, 'bf', ['illuminance_fc', 'bit1', 'bit2', 'bit3',
                                      'bit4', 'bit5', 'bit6', 'bit7']],
        'fb.current_pos'   : [30, 'us'],
		'fb.rel_pressure'  : [32, 'us', 0.1, 1],
		'fb.abs_pressure'  : [34, 'us', 0.1, 1],
		'fb.lux_wm2_coeff' : [36, 'us', 0.1],
        'fb.date_time'     : [43, 'dt'],
		NA: [0,'XX']
	},
	// OK, this is a bit naf but it works
	_pad: function (str, n) {
		return ('                    '+str).slice(n*-1);
	},
	// a collection of data conversion utilities that make assumptions about byte boundaries
	_d: {
		// translates offset to block/offset format
		'x': function(offset) {
			return [Math.floor(offset/8),offset%8];
		},
		// returns converted station unsigned short to real-world usable number
		// optionally applies conversion and precision.
		// byte coded decimal
		'bc' : function(data,blk,i) {
			var byte = data[blk][i];
			return ((Math.floor(byte/16)&0x0f)*10)+(byte&0x0f);
		},
		// bit field
		'bf' : function(data,blk,i,base,prec) {
			var map = {};
			var lo = data[blk][i];
			var bits = [1,2,4,8,16,32,64,128];
			for(var i = 0; i<bits.length&&i<base.length; i++) {
				map[base[i]] = (lo&bits[i]) > 0;
			}
			return map;
		},
		// signed byte
		'sb' : function(data,blk,i,base,prec) {
			return (data[blk][i]>=128) ? (128-data[blk][i]) : data[blk][i];
		},
		// plain byte
		'pb' : function(data,blk,i) {
			return data[blk][i];
		},
		// unsigned byte
		'ub' : function(data,blk,i,base,prec) {
			var res = (data[blk][i] === 0xFF) ? null : data[blk][i];
			if(base) {
				res *= base;
			}
			return (prec) ? Number(res.toFixed(prec)) : res;
		},
		// signed short
		'ss' : function(data,blk,i,base,prec) {
			var hb = (i+1<8)?blk:blk+1, hbi = (i+1<8)?i+1:(7-i);
			var hi = data[hb][hbi];
			var lo = data[blk][i];
			var res = null;
			if(lo === 0xFF && hi === 0xFF) return res;
			if (hi>=128) {
				res = ((128-hi)*256) - lo;
			} else {
				res = (hi*256)+lo;
			}
			if(base) {
				res *= base;
			}
			return (prec) ? Number(res.toFixed(prec)) : res;
		},
		// unsigned short
		'us' : function(data,blk,i,base,prec) {
			var hb = (i+1<8)?blk:blk+1, hbi = (i+1<8)?i+1:(7-i);
			var hi = data[hb][hbi];
			var lo = data[blk][i];
			if(lo === 0xFF && hi === 0xFF) return null;
			var res = (hi*256)+lo;
			if(base) {
				res *= base;
			}
			return (prec) ? Number(res.toFixed(prec)) : res;
		},
		p: function(v,l) {
			return ('00000'+v).slice(-l);
		},
		'wa' : function(data,blk,i,base,prec) {
			var lo = data[blk][i];
			var hi = data[blk][i+2]&0x0f;
			var res = hi<<8+lo;
			return (prec) ? Number(res.toFixed(prec)) : res;
		},
		'wg' : function(data,blk,i,base,prec) {
			var lo = data[blk][i];
			var hi = data[blk][i+1]&0xf0;
			var res = hi<<4+lo;
			return (prec) ? Number(res.toFixed(prec)) : res;
		},
		// date time
		'dt' : function(data,blk,i,base,prec) {
			var yy = wusb._d.bc(data,blk,i);
			var mm = wusb._d.bc(data,blk,i+1);
			var dd = wusb._d.bc(data,blk,i+2);
			var hr = wusb._d.bc(data,blk,i+3);
			var mi = wusb._d.bc(data,blk,i+4);
			return '20'+wusb._d.p(yy,2)+'-'+wusb._d.p(mm,2)+'-'+wusb._d.p(dd,2)+' '+wusb._d.p(hr,2)+':'+wusb._d.p(mi,2);
		}
	},
	// helper function for implementing data conversions.
	d: function(offset,format,base,prec) {
		// console.log(this.length,offset,format);
		if(offset<this.length*8) {
			var i = wusb._d.x(offset);
			if (wusb._d[format]) {
				return wusb._d[format](this,i[0],i[1],base,prec);
			} else {
				// if no convertor registered dump a string representation
				return [offset,'|',i[0],i[1],'>>',this[i[0]][i[1]], '0x'+Number(this[i[0]][i[1]]).toString(16).toUpperCase()].join(',');
			}
		}
	},
	// helper function for accessing dictionary
	f: function(data, name) {
		var ans = 'NA';
		if(wusb._map[name]) {
			ans = wusb.d.apply(data, wusb._map[name]);
		}
		return ans;
	},
	decode: function(data, list_or_bool) {
		var block = {};
		if(list_or_bool.length) {
			// TBD - decode a list of variables
		} else {
			// decode fixed dictionary or individual weather record
			var pre = (list_or_bool) ? 'fb.':'rf.';
			for(var key in wusb._map) {
				if( key.indexOf(pre) === 0 ) {
					block[key] = wusb.f(data,key);
				}
			}
		}
		return block;
	},
	open: function() {
		var devices = HID.devices();
		var device = null;
		for(var d in devices) {
			if(devices[d].vendorId === wusb.conf.vid && devices[d].productId === wusb.conf.pid) {
				return new HID.HID(devices[d].path);
			}
		}
		return device;
	},
	// return a array of addresses inclusive of lo to hi using the provided increment
	range: function(lo,hi,inc) {
		var v = [];
		var max = (Math.floor(hi/8)+1)*8
		for(var c=lo; c<max; c+=inc) {
			v.push(c);
		}
		if(wusb.conf.debug>3) console.log('_range:',lo, hi, max, inc, v);
		return v;
	},
	// construct a command block to send to USB device
	cmd: function(address) {
		var hi = Math.floor(address/256), lo = address%256;
		return [0xA1, hi, lo, 0x20,0xA1, hi, lo, 0x20];
	},
	// I had problems with removeListners so implemented this, need to revisit to know if actually needed
	removeListeners: function(d, f) {
		var listeners = station.listeners(f);
		if(wusb.conf.debug>3) console.log('listeners',listeners);
		if(listeners.length>0) {
			for(var l=0; l<listeners.length; l++) {
				d.removeListener(f,listeners[l]);
			}
		}
	},
	// setup a bulk transfer and fire a function when complete
	getRange: function(station, to, from, finished) {
		var locs = wusb.range(to, from, 32);
		if(wusb.conf.debug>2) console.log('range',locs);
		var count = -1;
		var buf = [];
		// request the next block of data sent by USB device
		var _next = function() {
			if(locs.length>0) {
				var addr = locs.shift();
				var cmd = wusb.cmd(addr);
				count = 4; // the number of bytes in the expected response from device
				station.write(cmd);
			} else {
				// make sure all listeners removed, before calling finished
				wusb.removeListeners(station, 'data');
				finished(buf);
			}
		};
		// collect the data and store
		var _chunk = function (data) {
			buf.push(data);
			count--;
			if(count===0) {
				_next();
			}
		};
		// make sure all listeners removed, before binding new local function
		wusb.removeListeners(station, 'data');
		station.on('data',_chunk);
		_next();
	},
	lastUpdated: function() {
		var dt = fixed['fb.date_time']+'Z'+((fixed['fb.timezone']<0)?'-':'+')+fixed['fb.timezone'];
		return dt;
	},
	// poll the weather station
	//  1. get the fixed block and extract the current location of the active record
	//  2. get the current record, store in recent array, set currrent weather global, setup next poll
	poll: function() {
		var started = process.hrtime();
		wusb.getRange(station, 0x00,0xff,function(fb) {
			fixed = wusb.decode(fb,true);
			var current  = fixed['fb.current_pos'];
			interval  = (wusb.conf.tandem) ? fixed['fb.read_period']*1000*60 : 1000*wusb.conf.interval; // sync to station updates or interval
			console.log(new Date(), 'station polled, next',interval/1000);
			wusb.getRange(station, current, current,function(reading) {
				var completed = process.hrtime(started); // [secs,ns]
				interval -= completed[0]*1000+completed[1]/1000000; // correct read time for time taken to read data to stop drifting
				if(wusb.conf.debug>0) console.log('read location',current,' in ',completed,' next read in ', interval,'ms');
				weather = wusb.decode(reading,false);
				// prepend this weather record to recent array and trim to required length
				wusb.recent.unshift(weather);
				wusb.recent = wusb.recent.slice(0,wusb.conf.recent||5);
				// setup date info - note that the USB device time may be out of sync
				weather.unix = (new Date(wusb.lastUpdated())).getTime() - weather['rf.delay']*60000;
				weather.datetime = new Date(weather.unix);
				weather.lastUpdated = new Date(wusb.lastUpdated());
				setTimeout(wusb.poll, interval);
			});
		});
	}
}
// some global vars
var weather = {};
var fixed = {};
var history = [];
var interval = 1000;
// ok, let's attempt to find the weather station by the USB ids (see wusb.conf) 
var station = wusb.open();
if (station == null ) {
	console.log('cannot find usb weather station, exiting.');
	process.exit(1)
}
console.log('weather station ready, polling');
// initialse weather
wusb.poll();
// define rest/json services
function getWeather(req, res){
    res.setHeader('Access-Control-Allow-Origin','*');
    console.log('sending current weather');
    res.send(200 , weather);
    return; 
}
function getFixed(req, res){
    res.setHeader('Access-Control-Allow-Origin','*');
    console.log('sending current settings');
    res.send(200 , fixed);
    return; 
}
function getRecent(req, res){
    res.setHeader('Access-Control-Allow-Origin','*');
    console.log('sending recent analysis');
	var recent = {
		data: wusb.recent,
		raining: wusb.recent.length>1&&wusb.recent[0]['rf.rain']>wusb.recent[wusb.recent.length-1]['rf.rain']
	}
    res.send(200 , recent);
    return; 
}
function getHistory(req, res){
    res.setHeader('Access-Control-Allow-Origin','*');
    console.log('sending weather history');
    var current  = fixed['fb.current_pos'];
	var unix = weather.unix;
	if(history.length>2 && (Date.now()-history[1].unix)>60*60000) {
		console.log('clearing history cache');
		history=[];
	}
	if ( history.length == 0) {
		console.log('reading history from device');
		wusb.getRange(station, 0x100, current, function(data) {
			for(var i=data.length-4; i>=0; i-=4) {
				var reading = wusb.decode(data.slice(i,i+4),false);
				unix = unix - (reading['rf.delay']*60000);
				reading.unix = unix;
				reading.datetime = new Date(reading.unix);
				history.push(reading);
			}
		    res.send(200 , [weather].concat(history));
		});
	} else {
		console.log('cached history');
	    res.send(200 , [weather].concat(history));
	}
    return; 
}
// set up restful service
var port    =  '8083';
var server = restify.createServer({
    name : "node"
});
var folder = '/homepage';
var static = connect.static(__dirname + folder);
server.listen(port, function(){
    console.log('%s listening at %s ', server.name , server.url, __dirname);
});
server.use(restify.queryParser());
server.use(restify.bodyParser());
server.use(restify.CORS());
server.get({path : '/weather/now' , version : '0.0.1'} , getWeather);
server.get({path : '/weather/settings' , version : '0.0.1'} , getFixed);
server.get({path : '/weather/recent' , version : '0.0.1'} , getRecent);
server.get({path : '/weather/history' , version : '0.0.1'} , getHistory);
server.get(/\/homepage\/.+/, function(req, res, next) {
  console.log('static get', req.url);
  req.url = req.url.substr(folder.length); // take off leading /docs so that connect locates it correctly
  return static(req, res, next);
});



