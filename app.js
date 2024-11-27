class App {
    view() {
        return m('div', {},
            m('aside', {}, m(Navbar)),
            m('main', {}, m(Content))
        )
    }
}

class Navbar {
    items() {
        return {
            'Home': '/',
            'About': '/about'
        };
    }
    
    view() {
        const links = this.items();
        return m('ul', {},
            Object.keys(links).map((name) => {
                return m('li', {},
                    m('a', {href: links[name]}, name)
                )
            })
        )
    }
}

class Content {
    name = 'World';
    counter = 0;

    welcome() {
        return m('div', {},
            'Hello ',
            m('b', {}, this.name),
            '!'
        );
    }

    view() {
        return m(m.Fragment, {},
            this.welcome(),
            m('p', {}, `Clicked ${this.counter} time(s).`),
            m('button', {
                onclick: () => {
                    this.counter++;
                    this.redraw();
                }
            }, 'Click me!')
        );
    }
}

extend(Navbar.prototype, 'items', (items) => {
    items['Contacts'] = '/contacts';
});

override(Content.prototype, 'welcome', function() {
    return m('div', {},
        'Nice to meet you, ',
        m('b', {}, this.name),
        '!'
    );
});

m.mount(document.getElementById('app'), createComponentFunc(App));
