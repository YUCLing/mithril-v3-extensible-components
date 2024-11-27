function App() {
    return m('div', {},
        m('aside', {}, m(Navbar)),
        m('main', {}, m(Content))
    );
}

function Navbar() {
    const links = Navbar.items();
    return m('ul', {},
        Object.keys(links).map((name) => {
            return m('li', {},
                m('a', {href: links[name]}, name)
            )
        })
    )
};

Navbar.items = function() {
    return {
        'Home': '/',
        'About': '/about'
    };
};

function Content(attrs, old) {
    attrs.name = old?.name ?? 'World';
    attrs.counter = old?.counter ?? 0;
    return m(m.Fragment, {},
        Content.welcome.apply(attrs),
        m('p', {}, `Clicked ${attrs.counter} time(s).`),
        m('button', {
            onclick: () => {
                attrs.counter++;
                this.redraw();
            }
        }, 'Click me!')
    );
}

Content.welcome = function() {
    return m('div', {},
        'Hello ',
        m('b', {}, this.name),
        '!'
    );
}

extend(Navbar, 'items', (items) => {
    items['Contacts'] = '/contacts';
});

override(Content, 'welcome', function() {
    return m('div', {},
        'Nice to meet you, ',
        m('b', {}, this.name),
        '!'
    );
});

m.mount(document.getElementById('app'), App);
