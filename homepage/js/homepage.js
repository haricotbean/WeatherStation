var hp = {
    debug: true,
    opts: {
        
    },
    init: function(opts) {
        $.extend(hp.opts,opts);
        console.log(hp.opts);
        if(hp.opts.name) {
            $(hp.opts.homecss||'span.home').text(hp.opts.name);
        }
        return hp;
    },
    getJSON: function(url, isec, handler) {
        $.getJSON(url, function(data) {
            if (hp.debug)
                console.log('called url', url, data, isec);
            var repeat = false;
            try {
                if (typeof handler === "function") {
                    repeat = handler(data);
                }
            } catch (e) {
                if (hp.debug)
                    console.log(e);
            }
            if (repeat && isec) {
                var delay = isec * 1000;
                if (hp.debug)
                    console.log('setting repeat in', isec, 's', delay);
                setTimeout(function() {
                    hp.getJSON(url, isec, handler);
                }, delay);
            }
        });
        return hp; // chain
    }
};


